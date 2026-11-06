[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$GamePath,
    [Parameter(Mandatory = $true)][string]$ModsPath,
    [Parameter(Mandatory = $true)][string]$FixtureRoot,
    [Parameter(Mandatory = $true)][string]$SaveName,
    [Parameter(Mandatory = $true)][string]$TemplateName,
    [Parameter(Mandatory = $true)][string]$ReleaseDir,
    [Parameter(Mandatory = $true)][string]$ResultFile,
    [Parameter(Mandatory = $true)][string]$LifecycleResultFile,
    [string]$ScenarioIdentity,
    [string]$Action = "move_to_tile",
    [string]$WindowMode = "visible",
    [switch]$BootstrapNativeSave,
    [ValidateRange(30, 300)][int]$TimeoutSeconds = 120,
    # PRELIVE ONLY: prove the fixture boots, arms its world, speaks over the bridge and leaves cleanly - no
    # action is dispatched and no model is called. The run stops after four rungs and writes -PreliveResultFile.
    [switch]$PreliveOnly,
    [string]$PreliveResultFile
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$smapi = Join-Path $GamePath "StardewModdingAPI.exe"
# The one canonical lifecycle result destination must be canonical before any
# preflight failure can be reported through it. The package-owned closure
# backend always provides this claim and consumes exactly one terminal result.
if (-not [IO.Path]::IsPathFullyQualified($LifecycleResultFile)) { throw "LifecycleResultFile must be an absolute private result path." }
$lifecycleResultPath = [IO.Path]::GetFullPath($LifecycleResultFile)
$packageRoot = Join-Path (Join-Path $PSScriptRoot "..") "integrations/stardew/action-development"
$equipToolChild = Join-Path $packageRoot "scenarios/equip-tool-live-child.mjs"
$lifecycleResultWriter = Join-Path $packageRoot "scenarios/write-lifecycle-result.mjs"
# The Mod folder name comes from its ONE owner (tools/lib/stardew-mod-folder.mjs). Written out here as
# `GameBuddy.Stardew` it disagreed with the folder the fixture library deploys to, so every run refused at
# input_validation with "Missing harness path: ...\mods\GameBuddy.Stardew\config.json" - and creating that
# folder instead would have made SMAPI load the same UniqueID twice and start WITHOUT the mod.
$modFolderModule = ([uri]::new((Join-Path $PSScriptRoot 'lib/stardew-mod-folder.mjs'))).AbsoluteUri
$modFolder = node --input-type=module -e "import { STARDEW_MOD_FOLDER } from '$modFolderModule'; process.stdout.write(STARDEW_MOD_FOLDER)"
if ([string]::IsNullOrWhiteSpace($modFolder)) { throw "Could not read STARDEW_MOD_FOLDER from $modFolderModule." }
$clientConfig = Join-Path (Join-Path $ModsPath $modFolder.Trim()) "config.json"
$backupName = "native-local-$($Action.Replace('_', '-'))-fixture-backup"
$fixtureSaveHarness = Join-Path $PSScriptRoot "prepare-stardew-action-fixture.ps1"
$stardewSaveRoot = Join-Path $env:APPDATA "StardewValley\Saves"
$pipeReadinessHelper = Join-Path $PSScriptRoot "lib/stardew-named-pipe-readiness.ps1"
. $pipeReadinessHelper
$runnerResolver = Join-Path $PSScriptRoot "resolve-stardew-action-gate-runner.mjs"
$liveRunTool = Join-Path $PSScriptRoot "lib/stardew-live-run.mjs"
$preliveLadderTool = Join-Path $PSScriptRoot "lib/stardew-prelive-ladder.mjs"
$errorLogsDir = Join-Path $env:APPDATA "StardewValley\ErrorLogs"
$preliveLadder = $null
$preliveResultPath = $null

function Publish-FailureLifecycleResult([string]$Phase) {
    try {
        if (Test-Path -LiteralPath $lifecycleResultPath) { Remove-Item -Force -LiteralPath $lifecycleResultPath -ErrorAction SilentlyContinue }
        node $lifecycleResultWriter --result-file $lifecycleResultPath --state failed --phase $Phase --code failed
    } catch {}
}

# PRELIVE LADDER STATE. The rung numbers and codes have ONE authority
# (tools/lib/stardew-prelive-ladder.mjs) and the launcher reads them, so a renamed rung cannot survive here
# as a stale second spelling.
$prelive = [pscustomobject]@{
    enabled = $PreliveOnly.IsPresent
    rung = 0
    code = $null
    detail = $null
    failure = $null
    logPath = $null
    logOffset = 0
    launchedAtMs = 0
    startedAtUtc = [DateTime]::UtcNow
    timings = [ordered]@{}
}

function Get-PreliveLadder {
    if ($null -eq $preliveLadder) {
        $text = node $preliveLadderTool --mode ladder
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($text)) { throw "Prelive ladder contract could not be read from $preliveLadderTool." }
        $preliveLadder = $text | ConvertFrom-Json
    }
    return $preliveLadder
}

function Get-PreliveFailureCode([string]$Name) {
    $value = (Get-PreliveLadder).failureCodes.$Name
    if ([string]::IsNullOrWhiteSpace([string]$value)) { throw "Prelive ladder has no failure code '$Name'." }
    return [string]$value
}

function Set-PreliveRung([int]$Rung, [string]$Detail) {
    if (-not $prelive.enabled) { return }
    $row = @((Get-PreliveLadder).rungs | Where-Object { $_.rung -eq $Rung })
    if ($row.Count -ne 1) { throw "Prelive ladder has no rung $Rung." }
    $prelive.rung = $Rung
    $prelive.code = [string]$row[0].passCode
    $prelive.detail = $Detail
    $prelive.timings[[string]$row[0].name] = [int]([DateTime]::UtcNow - $prelive.startedAtUtc).TotalMilliseconds
}

function Register-PreliveRungFailure([int]$Rung, [string]$Code, [string]$Detail) {
    # First failure wins: a later rung cannot overwrite the cause of an earlier red, and the teardown that
    # follows a red rung is not allowed to relabel it.
    if (-not $prelive.enabled -or $null -ne $prelive.failure) { return }
    $prelive.failure = [pscustomobject]@{ rung = $Rung; code = $Code; detail = $Detail }
    $prelive.timings["failed_rung_$Rung"] = [int]([DateTime]::UtcNow - $prelive.startedAtUtc).TotalMilliseconds
}

function Register-PreliveUnreachedFailure([string]$Phase, $Failure) {
    # Anything that stops the run before a rung could be judged is rung 1: the ladder never got past the
    # profile the Mod has to accept.
    if (-not $prelive.enabled -or $null -ne $prelive.failure) { return }
    $message = if ($Failure -is [System.Management.Automation.ErrorRecord]) { [string]$Failure.Exception.Message } else { [string]$Failure }
    Register-PreliveRungFailure 1 (Get-PreliveFailureCode 'launchFailed') ("{0}: {1}" -f $Phase, $message)
}

function Publish-PreliveResult {
    if (-not $prelive.enabled) { return }
    if ([string]::IsNullOrWhiteSpace($preliveResultPath)) { throw "Prelive result path was not established." }
    if ($null -eq $prelive.failure) {
        $state = "passed"
        $rungNumber = $prelive.rung
        $code = $prelive.code
        $detail = $prelive.detail
    } else {
        $state = "failed"
        $rungNumber = [int]$prelive.failure.rung
        $code = [string]$prelive.failure.code
        $detail = [string]$prelive.failure.detail
    }
    $prelive.timings["totalMs"] = [int]([DateTime]::UtcNow - $prelive.startedAtUtc).TotalMilliseconds
    $payload = [ordered]@{
        state = $state
        rung = $rungNumber
        code = $code
        detail = $detail
        timings = $prelive.timings
    } | ConvertTo-Json -Depth 5
    # UTF-8 WITHOUT a BOM and no trailing newline: `Set-Content` follows the console codepage (which mangles a
    # non-ASCII location name) and PowerShell 5.1's `-Encoding UTF8` prepends a BOM that strict JSON readers
    # reject. The result is read by tools, so it is written by explicit bytes.
    [IO.File]::WriteAllText($preliveResultPath, $payload, (New-Object System.Text.UTF8Encoding($false)))
    # ONE line, naming the rung that failed (or the last rung that passed).
    Write-Output ("prelive {0} rung={1} code={2} detail={3}" -f $state, $rungNumber, $code, $detail)
}

function Invoke-PreliveSnapshotRung([string]$ClientConfig) {
    # RUNG 3 dispatches nothing: it connects the way a smoke runner does, waits for an actionable snapshot,
    # and then DISCONNECTS on purpose - that close is what rung 4 audits.
    $phase = "prelive_rung_3_first_snapshot_actionable"
    $arguments = @($preliveLadderTool, "--mode", "snapshot", "--client-config", $ClientConfig)
    if (-not [string]::IsNullOrWhiteSpace($prelive.logPath)) { $arguments += @("--log", $prelive.logPath) }
    $probeText = & node @arguments
    if ([string]::IsNullOrWhiteSpace($probeText)) { throw "Prelive rung 3 produced no snapshot probe result." }
    $probe = $probeText | ConvertFrom-Json
    # The probe closes its client BEFORE it prints, so this capture is the exact log boundary of the
    # deliberate disconnect - and re-resolving the file here means a rotation during the run cannot point
    # rung 4 at the previous run's bytes.
    $resolvedText = node $preliveLadderTool --mode log --error-logs $errorLogsDir --since-ms $prelive.launchedAtMs
    if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($resolvedText)) {
        $resolved = $resolvedText | ConvertFrom-Json
        if (-not [string]::IsNullOrWhiteSpace([string]$resolved.path)) {
            $prelive.logPath = [string]$resolved.path
            $prelive.logOffset = [long]$resolved.length
        }
    }
    if (-not $probe.passed) {
        Register-PreliveRungFailure 3 ([string]$probe.code) ([string]$probe.detail)
        throw "Prelive rung 3 $($probe.code): $($probe.detail)"
    }
    Set-PreliveRung 3 ([string]$probe.detail)
}

function Get-StardewProcessIds() {
    # Read-only, for a REPORT. Nothing is killed by image name anywhere in this driver: `taskkill` takes the exact
    # PID this transaction launched.
    return @(Get-Process -Name 'StardewModdingAPI','Stardew Valley','StardewValley' -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
}

function Assert-CannotHaveForgottenOwnGame([string]$Phase, [int[]]$OwnProcessIds) {
    # The failure this guards is a FORGOTTEN game of our own: a previous fixture transaction that left its game
    # running makes the fixture files and the save slot unsafe to touch, and the message has to say so.
    #
    # It deliberately does NOT require the machine to be free of every Stardew process. That wider rule made two
    # lanes mutually impossible: lane B saw lane A's game and refused with "requires no pre-existing
    # Stardew/SMAPI process before fixture preparation (PIDs: 37292,41044)", even though every file, pipe, save slot
    # and lock it used was its own. Whether a process belongs to THIS transaction is knowable (it launched it), and
    # whether a stranger's game should keep running is not this driver's decision - the player may be playing.
    $running = @(Get-StardewProcessIds)
    $owned = @($running | Where-Object { $OwnProcessIds -contains $_ })
    if ($owned.Count -gt 0) {
        throw "Native-local fixture requires the game it launched to be gone before $Phase (owned PIDs: $($owned -join ','))."
    }
    if ($running.Count -gt 0) {
        Write-Warning "Another Stardew/SMAPI process is running during $Phase (PIDs: $($running -join ',')). It is not this transaction's and is left alone."
    }
}

$phase = "runner_resolution"
$failure = $null
$failurePhase = $null
try {
    $phase = "input_validation"
    if (-not [IO.Path]::IsPathFullyQualified($ReleaseDir)) { throw "ReleaseDir must be an absolute staged bundle path." }
    if (-not [IO.Path]::IsPathFullyQualified($ResultFile)) { throw "ResultFile must be an absolute private result path." }
    $releaseDir = [IO.Path]::GetFullPath($ReleaseDir).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $actionResultPath = [IO.Path]::GetFullPath($ResultFile)
    if ($actionResultPath -eq $lifecycleResultPath) { throw "Action and lifecycle result files must be separate." }
    if (Test-Path -LiteralPath $actionResultPath) { Remove-Item -Force -LiteralPath $actionResultPath -ErrorAction SilentlyContinue }
    if (Test-Path -LiteralPath $lifecycleResultPath) { Remove-Item -Force -LiteralPath $lifecycleResultPath -ErrorAction SilentlyContinue }
    if ($Action -eq "equip_tool") {
        if ([string]::IsNullOrWhiteSpace($ScenarioIdentity)) { throw "equip_tool requires ScenarioIdentity." }
        try { $null = $ScenarioIdentity | ConvertFrom-Json } catch { throw "ScenarioIdentity must be valid JSON." }
    }
    if ($PreliveOnly) {
        # The prelive result is the ONLY artefact this mode produces, so its path is validated before anything
        # is prepared or launched - a run that cannot report its rungs must not boot a game to find out.
        if ([string]::IsNullOrWhiteSpace($PreliveResultFile)) { throw "PreliveOnly requires PreliveResultFile." }
        if (-not [IO.Path]::IsPathFullyQualified($PreliveResultFile)) { throw "PreliveResultFile must be an absolute private result path." }
        $preliveResultPath = [IO.Path]::GetFullPath($PreliveResultFile)
        if ($preliveResultPath -eq $actionResultPath -or $preliveResultPath -eq $lifecycleResultPath) { throw "Prelive results require their own result path." }
        if ($BootstrapNativeSave) { throw "PreliveOnly cannot run the bootstrap lane: a title-screen bootstrap never loads a world, so rungs 3 and 4 have nothing to observe." }
        if (Test-Path -LiteralPath $preliveResultPath) { Remove-Item -Force -LiteralPath $preliveResultPath -ErrorAction SilentlyContinue }
        # Read the ladder contract ONCE, before the launch it is supposed to judge: a missing or broken ladder
        # module would otherwise be discovered thirty seconds into a boot, in the teardown.
        $null = Get-PreliveLadder
        # RUNG 3's PRECONDITION, and also its own failure. The probe executes `host/dist-test` through
        # `loadHostTestModule`, which refuses an artifact older than its sources; asked only at observe time,
        # that refusal was reported under the snapshot-not-actionable code - naming a blocker nobody saw.
        # Same authority the loader asks, its own code, the newest input, the artifact and the rebuild command,
        # and it is asked HERE so a stale build costs two seconds instead of a boot.
        $phase = "prelive_harness_freshness"
        $harnessText = node $preliveLadderTool --mode harness
        if ([string]::IsNullOrWhiteSpace($harnessText)) { throw "Prelive harness freshness could not be read ($preliveLadderTool --mode harness)." }
        $harness = $harnessText | ConvertFrom-Json
        if (-not $harness.passed) {
            Register-PreliveRungFailure 3 ([string]$harness.code) ([string]$harness.detail)
            throw "Prelive rung 3 $($harness.code): $($harness.detail)"
        }
        $phase = "input_validation"
    }
    $phase = "runner_resolution"
    $smokeScript = node $runnerResolver --action $Action
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($smokeScript)) { throw "Native-local action runner resolution failed for '$Action'." }
    $smokeScript = $smokeScript.Trim()
    if ($smokeScript -notmatch '^run-stardew-native-local-player-[a-z0-9-]+-smoke\.mjs$') { throw "Native-local action runner resolution returned an invalid runner identity." }
    $phase = "input_validation"
    foreach ($path in @($smapi, $ModsPath, $FixtureRoot, $releaseDir, $clientConfig, $equipToolChild, $lifecycleResultWriter)) { if (-not (Test-Path -LiteralPath $path)) { throw "Missing harness path: $path" } }
    if (-not $BootstrapNativeSave -and $SaveName -notmatch '^GameBuddyFixture[A-Za-z0-9]{0,64}_[0-9]{1,32}$') { throw "A disposable action run requires an observed physical GameBuddyFixture slot ending in _<nativeUniqueId>." }
    # THE RUN'S OWN ENVIRONMENT IS PINNED, NOT INHERITED.
    #
    # The Mod already fixes what it can from inside the game (pauseWhenOutOfFocus=false, music/sound volume 0,
    # InactiveSleepTime=0, power throttling off, and the window mode from GAMEBUDDY_WINDOW_MODE), so a run's
    # screen and audio state is code-fixed. The engine's startup_preferences is NOT: the game reads it before
    # the Mod loads, and this lane's fixture REFUSES TO LOAD THE SAVE until the live game locale matches the
    # locale the Mod config will demand. Left to the operator, a healthy code path sat for the whole pipe
    # timeout and reported `bridge_never_ready`, because the fixture was waiting for a locale the game was
    # never going to switch to.
    #
    # So the precondition is asserted HERE against the SAME source of truth the fixture config uses, and it
    # fails with a name and the exact fix instead of hanging. It refuses rather than rewriting: this is the
    # operator's game preference file, and another lane's launcher asserts it identically (`live_locale_required`).
    $phase = "live_run_preferences"
    $startupPreferencesPath = Join-Path $env:APPDATA "StardewValley/startup_preferences"
    if (-not (Test-Path -LiteralPath $startupPreferencesPath -PathType Leaf)) {
        throw "Live locale required: $startupPreferencesPath does not exist, so the game would start on its default locale while this lane's fixture refuses to load the save until it matches the configured one. Start the game once with the intended language, then re-run."
    }
    $requiredLanguageCode = if ($env:GAMEBUDDY_COMPANION_LOCALE -eq "en-US") { "en-US" } else { "zh-CN" }
    # TWO VOCABULARIES, and confusing them is silent: the fixture config carries the Mod's BCP-47 locale
    # (`zh-CN`), while this file carries the GAME's own enum name for that language (`zh`, from
    # LocalizedContentManager.LanguageCode: en/ja/zh/...). Writing the BCP-47 value here makes the engine
    # ignore the preference and start in English, so the fixture then waits for a locale the game was never
    # asked for - which is how a healthy code path came to sit out the whole pipe timeout. Map, do not copy.
    $requiredPreferenceValue = if ($requiredLanguageCode -eq "en-US") { "en" } else { "zh" }
    $preferenceLanguageCode = $null
    try {
        [xml]$startupPreferences = [IO.File]::ReadAllText($startupPreferencesPath)
        $preferenceLanguageCode = [string]$startupPreferences.StartupPreferences.languageCode
    } catch {
        throw "Live locale required: $startupPreferencesPath could not be read as XML ($($_.Exception.Message))."
    }
    if ($preferenceLanguageCode -ne $requiredPreferenceValue) {
        throw "Live locale required: the game's startup_preferences languageCode is '$preferenceLanguageCode' but this run needs '$requiredPreferenceValue' (the game's enum name for the '$requiredLanguageCode' locale the fixture config demands, and which the Mod waits to observe live before it loads the save). Set <languageCode>$requiredPreferenceValue</languageCode> in $startupPreferencesPath, or run with GAMEBUDDY_COMPANION_LOCALE=$preferenceLanguageCode."
    }
    # This guard precedes every profile/config/bundle mutation. The one process
    # launched below is therefore the only game process in this transaction.
    Assert-CannotHaveForgottenOwnGame 'fixture preparation' @()
} catch {
    $failure = $_
    $failurePhase = $phase
    Publish-FailureLifecycleResult $failurePhase
    throw $failure
}

function Get-NormalizedWindowsPath([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Assert-LaunchedSmapiIdentity([string]$ExpectedSmapi, [string]$ExpectedModsPath, [int]$ExpectedProcessId) {
    # A stale launcher can hand off to another installation, whose default Mods
    # root may expose a valid but unrelated pipe. Attest the actual running
    # SMAPI process before any bridge request, not merely the requested command.
        $expectedSmapiPath = Get-NormalizedWindowsPath $ExpectedSmapi
        $expectedModsPath = Get-NormalizedWindowsPath $ExpectedModsPath
        $running = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -ieq 'StardewModdingAPI.exe' })
        # Identity is the EXACT process this transaction launched, not how many SMAPI processes happen to exist.
        #
        # The guard here used to require `$running.Count -eq 1` across the whole machine, which made two lanes
        # mutually impossible: lane B counted lane A's game and refused with "requires exactly one SMAPI process
        # (PIDs: 37292,41044)" even though every file, pipe and save slot was its own. The count was only ever a
        # proxy for the real question ("is the process I launched the one that is running?"), and the exact-PID
        # check below answers it directly and more strictly. Ownership of a stray process is not this
        # transaction's business: the launcher reclaims by its own PID and asserts zero survivors.
        $actual = $running | Where-Object { $_.ProcessId -eq $ExpectedProcessId } | Select-Object -First 1
        if ($null -eq $actual) {
            $ids = ($running | ForEach-Object ProcessId) -join ','
            throw "Native-local launch identity mismatch: the SMAPI process launched by this transaction (PID $ExpectedProcessId) is not running after pipe readiness (other SMAPI PIDs: $ids); no bridge action was sent."
        }
        if ([string]::IsNullOrWhiteSpace($actual.ExecutablePath) -or -not [string]::Equals((Get-NormalizedWindowsPath $actual.ExecutablePath), $expectedSmapiPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Native-local launch identity mismatch: SMAPI did not remain in the requested GamePath; no bridge action was sent."
    }
    # Do not use substring matching here: an unrelated --mods-path such as
    # C:\fixture\Mods-stale would otherwise satisfy a C:\fixture\Mods probe.
    # Parse the actual option and require exactly one, exact normalized value.
    $commandLine = if ([string]::IsNullOrWhiteSpace($actual.CommandLine)) { "" } else { $actual.CommandLine }
    $modsPathMatches = [regex]::Matches(
        $commandLine,
        '(?i)(?:^|\s)--mods-path\s+(?:"(?<double>[^"]+)"|''(?<single>[^'']+)''|(?<bare>[^\s]+))')
    if ($modsPathMatches.Count -ne 1) {
        throw "Native-local launch identity mismatch: SMAPI command line must contain exactly one well-formed --mods-path; no bridge action was sent."
    }
    $match = $modsPathMatches[0]
    $actualModsPath = if ($match.Groups['double'].Success) { $match.Groups['double'].Value } elseif ($match.Groups['single'].Success) { $match.Groups['single'].Value } else { $match.Groups['bare'].Value }
    if ([string]::IsNullOrWhiteSpace($actualModsPath) -or -not [string]::Equals((Get-NormalizedWindowsPath $actualModsPath), $expectedModsPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Native-local launch identity mismatch: SMAPI did not retain the requested ModsPath; no bridge action was sent."
    }
}

function Test-IsIsolatedDesktop {
    try {
        Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DeskDetectFixture {
    [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint dwThreadId);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);
}
"@ -ErrorAction SilentlyContinue
        $cur = [DeskDetectFixture]::GetThreadDesktop([DeskDetectFixture]::GetCurrentThreadId())
        $sb = New-Object System.Text.StringBuilder 256
        $needed = 0
        [DeskDetectFixture]::GetUserObjectInformation($cur, 2, $sb, 256, [ref]$needed) | Out-Null
        return ($sb.ToString() -match "^exebox-")
    } catch {
        return $false
    }
}

function Start-InteractiveSmapiProcess {
    param(
        [Parameter(Mandatory=$true)][string]$FilePath,
        [string[]]$ArgumentList,
        [string]$WorkingDirectory,
        [string]$WindowStyle = "Normal"
    )
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class SmapiInteractiveLauncherFixture {
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool SetThreadDesktop(IntPtr hDesktop);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool CloseDesktop(IntPtr hDesktop);
}
"@ -ErrorAction SilentlyContinue

    $hDesk = [SmapiInteractiveLauncherFixture]::OpenInputDesktop(0, $false, 0x01FF)
    if ($hDesk -eq [IntPtr]::Zero) {
        $hDesk = [SmapiInteractiveLauncherFixture]::OpenDesktop("Default", 0, $false, 0x01FF)
    }
    if ($hDesk -eq [IntPtr]::Zero) {
        return Start-Process -FilePath $FilePath -ArgumentList $ArgumentList -WorkingDirectory $WorkingDirectory -WindowStyle $WindowStyle -PassThru
    }

    $runspace = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
    $runspace.Open()
    $runspace.SessionStateProxy.SetVariable("hDesk", $hDesk)
    $runspace.SessionStateProxy.SetVariable("FilePath", $FilePath)
    $runspace.SessionStateProxy.SetVariable("ArgumentList", $ArgumentList)
    $runspace.SessionStateProxy.SetVariable("WorkingDirectory", $WorkingDirectory)
    $runspace.SessionStateProxy.SetVariable("WindowStyle", $WindowStyle)

    $pipeline = $runspace.CreatePipeline()
    $pipeline.Commands.AddScript({
        [SmapiInteractiveLauncherFixture]::SetThreadDesktop($hDesk) | Out-Null
        $splat = @{
            FilePath = $FilePath
            PassThru = $true
        }
        if ($null -ne $ArgumentList -and $ArgumentList.Count -gt 0) { $splat["ArgumentList"] = $ArgumentList }
        if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) { $splat["WorkingDirectory"] = $WorkingDirectory }
        if (-not [string]::IsNullOrWhiteSpace($WindowStyle)) { $splat["WindowStyle"] = $WindowStyle }
        Start-Process @splat
    })

    $results = $pipeline.Invoke()
    $runspace.Close()
    [SmapiInteractiveLauncherFixture]::CloseDesktop($hDesk)
    return $results[0]
}

$prepared = $false
$workingSavePrepared = $false
$process = $null
if ($null -eq $failure) {
$phase = "fixture_prepare"
try {
    if ($BootstrapNativeSave) {
        if ($SaveName -notmatch '^GameBuddyFixture[A-Za-z0-9]{0,64}$') { throw "BootstrapNativeSave requires a logical GameBuddyFixture save name without a native unique-ID suffix." }
        node (Join-Path $PSScriptRoot "bootstrap-stardew-native-local-player-fixture.mjs") --root $FixtureRoot --mods-path $ModsPath --release-dir $releaseDir --logical-save-name $SaveName --backup-name $backupName --timeout-seconds $TimeoutSeconds --action $Action
        if ($LASTEXITCODE -ne 0) { throw "Native-local fixture bootstrap prepare failed." }
    } else {
        $bindingPath = Get-ChildItem -LiteralPath $FixtureRoot -Filter '*.native-local-binding.json' -File | Where-Object {
            try { (Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json).observedSaveSlot -eq $SaveName } catch { $false }
        } | Select-Object -First 1 -ExpandProperty FullName
        if ([string]::IsNullOrWhiteSpace($bindingPath)) { throw "Disposable native-local action run requires a bootstrap-captured binding whose observed slot is $SaveName." }
        node (Join-Path $PSScriptRoot "prepare-stardew-native-local-player-fixture.mjs") --root $FixtureRoot --mods-path $ModsPath --release-dir $releaseDir --save-name $SaveName --backup-name $backupName --timeout-seconds $TimeoutSeconds --action $Action --binding-path $bindingPath --stardew-save-root $stardewSaveRoot
        if ($LASTEXITCODE -ne 0) { throw "Native-local fixture prepare failed." }
    }
    $prepared = $true
    if (-not $BootstrapNativeSave) {
        $phase = "working_save_restore"
        # Restore an external, native-created template byte-for-byte as this
        # transaction's disposable observed-slot working save. No XML/save-state
        # patch is performed, and cleanup below removes only this exact slot.
        & $fixtureSaveHarness -FixtureRoot $FixtureRoot -TemplateName $TemplateName -SaveName $SaveName -StardewSaveRoot $stardewSaveRoot
        if ($LASTEXITCODE -ne 0) { throw "Native-local working-save restore failed." }
        $workingSavePrepared = $true
    }
    $phase = "bridge_enablement_precondition"
    # The fixture arms `NativeLocalPlayerFixture` but never enables `EnableLocalBridge`, and the fixture's
    # OWN verifier demands it (`assertBridgeConfig`, tools/lib/stardew-native-local-player-fixture.mjs).
    # Measured 2026-10-16: a profile seeded from config.example.json (`EnableLocalBridge: false`) loaded the
    # save, drained its bootstrap, logged `bridge=none` heartbeats for the whole budget, and died at the pipe
    # gate with `Native-local bridge pipe was not ready before timeout` - a cause that names nothing. Assert it
    # HERE, against the same field the Mod reads (ModConfig.HasValidLocalBridgeConfiguration), and refuse by name.
    $bridgeConfig = Get-Content -Raw -LiteralPath $clientConfig | ConvertFrom-Json
    if ($bridgeConfig.EnableLocalBridge -ne $true) {
        throw "Native-local fixture profile has EnableLocalBridge=false in $clientConfig, so the Mod will never open the pipe this run waits for. Seed the lane profile with EnableLocalBridge=true (see fixtures/stardew/RUNBOOK.md, native-local single-player SOP)."
    }
    $phase = "smapi_launch"
    # Window-mode vocabulary/validation lives in tools/lib/stardew-live-run.mjs
    # (mirror of host/src/live-run/window-mode.ts); the fixture reads the
    # single-authority JSON map instead of re-declaring the 5-mode switch.
    $windowMapText = node $liveRunTool --print-map 2>$null
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($windowMapText)) { throw "Native-local fixture could not resolve the window-mode map." }
    $windowMap = $windowMapText | ConvertFrom-Json
    $windowEntry = $windowMap.windowModes.$WindowMode
    if ($null -eq $windowEntry) { throw "Native-local fixture window mode '$WindowMode' is not in the single-authority window-mode contract." }
    $windowStyle = [string]$windowEntry.style
    $env:GAMEBUDDY_WINDOW_MODE = $WindowMode
    # The launch clock is taken BEFORE the child exists, so a log file this launch writes can never read as
    # older than the run (see resolvePreliveModLog).
    $prelive.launchedAtMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    # Start-Process joins ArgumentList tokens itself. Quote the custom path so its
    # embedded `Stardew Valley` space cannot truncate SMAPI's --mods-path value.
    if (Test-IsIsolatedDesktop) {
        $process = Start-InteractiveSmapiProcess -FilePath $smapi -ArgumentList @("--mods-path", ('"{0}"' -f $ModsPath)) -WorkingDirectory $GamePath -WindowStyle $windowStyle
    } else {
        $process = Start-Process -FilePath $smapi -ArgumentList @("--mods-path", ('"{0}"' -f $ModsPath)) -WorkingDirectory $GamePath -WindowStyle $windowStyle -PassThru
    }
    $pipeName = $bridgeConfig.PipeName
    if ([string]::IsNullOrWhiteSpace($pipeName)) { throw "Native-local fixture config has no pipe name." }
    if ($prelive.enabled) {
        # RUNG 1, BEFORE the pipe it precedes. A profile the Mod rejects is refused at launch and then idles
        # at frame=1 until the pipe bound expires, which is how a missing Mod-side scenario cost a 303-second
        # boot and reported `bridge_never_ready`. Read the Mod's own verdict here and quote the line.
        $phase = "prelive_rung_1_config_accepted"
        # Built as a token array, not a literal command line: an EMPTY `--scenario` value is dropped by
        # PowerShell's argument marshalling, which would hand `--timeout-seconds` to `--scenario` and turn the
        # ordinary world into a usage error. The ordinary world simply passes no scenario at all.
        $configArguments = @(
            $preliveLadderTool, "--mode", "config",
            "--error-logs", $errorLogsDir,
            "--since-ms", $prelive.launchedAtMs,
            "--timeout-seconds", $TimeoutSeconds
        )
        $armedScenario = [string]$bridgeConfig.NativeLocalPlayerFixture.FixtureScenario
        if (-not [string]::IsNullOrWhiteSpace($armedScenario)) { $configArguments += @("--scenario", $armedScenario) }
        $configRungText = & node @configArguments
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($configRungText)) { throw "Prelive rung 1 could not read the Mod log ($preliveLadderTool --mode config)." }
        $configRung = $configRungText | ConvertFrom-Json
        if (-not [string]::IsNullOrWhiteSpace([string]$configRung.logPath)) { $prelive.logPath = [string]$configRung.logPath }
        if (-not $configRung.passed) {
            Register-PreliveRungFailure 1 ([string]$configRung.code) ([string]$configRung.detail)
            throw "Prelive rung 1 $($configRung.code): $($configRung.detail)"
        }
        Set-PreliveRung 1 ([string]$configRung.detail)
    }
    $phase = "pipe_readiness"
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while (-not (Test-GameBuddyNamedPipeListening -PipeName $pipeName)) {
        Start-Sleep -Milliseconds 250
        if ($process.HasExited) {
            Register-PreliveRungFailure 2 (Get-PreliveFailureCode 'bridgeNotListening') "the SMAPI process exited before the bridge pipe answered"
            throw "Native-local SMAPI process exited before bridge smoke."
        }
        if ([DateTime]::UtcNow -ge $deadline) {
            Register-PreliveRungFailure 2 (Get-PreliveFailureCode 'bridgeNotListening') "the bridge pipe did not answer within $TimeoutSeconds s"
            throw "Native-local bridge pipe was not ready before timeout."
        }
    }
    Set-PreliveRung 2 "pipe=$pipeName answered within $TimeoutSeconds s"
    if ($WindowMode -ne "hidden") {
        try {
            $evidenceScript = Join-Path $PSScriptRoot "lib\capture-stardew-window-evidence.ps1"
            if (Test-Path -LiteralPath $evidenceScript) {
                & $evidenceScript -ProcessId $process.Id -WindowMode $WindowMode -Tag "preflight" | Out-Null
            }
        } catch {}
    }
    $phase = "launch_identity"
    Assert-LaunchedSmapiIdentity -ExpectedSmapi $smapi -ExpectedModsPath $ModsPath -ExpectedProcessId $process.Id
    $liveFixture = Get-Content -Raw -LiteralPath $clientConfig | ConvertFrom-Json
    if ($prelive.enabled) {
        $phase = "prelive_rung_3_first_snapshot_actionable"
        Invoke-PreliveSnapshotRung $clientConfig
        # The Mod handles the pipe EOF on its own game thread, so a disconnect-time exception is written a
        # tick or two AFTER the close. One bounded settle (2 s at 60 fps is ~120 ticks) gives rung 4 the line
        # it exists to find; the process is then torn down by the normal path below.
        $settleDeadline = [DateTime]::UtcNow.AddSeconds(2)
        while (-not $process.HasExited -and [DateTime]::UtcNow -lt $settleDeadline) { Start-Sleep -Milliseconds 100 }
    } elseif ($BootstrapNativeSave) {
        if ($liveFixture.NativeLocalPlayerFixture.Bootstrap.Enable -or $liveFixture.NativeLocalPlayerFixture.LogicalSaveName -ne $SaveName) {
            throw "Native-local bootstrap did not disarm with its requested logical save name; no action smoke was sent."
        }
        $bindingPath = Join-Path $FixtureRoot ("$SaveName.native-local-binding.json")
        $binding = [ordered]@{
            version = 1
            logicalSaveName = $liveFixture.NativeLocalPlayerFixture.LogicalSaveName
            observedSaveSlot = $liveFixture.NativeLocalPlayerFixture.ObservedSaveSlot
            saveId = $liveFixture.SaveId
            worldId = $liveFixture.WorldId
            playerId = $liveFixture.PlayerId
            companionId = $liveFixture.CompanionId
        }
        $binding | ConvertTo-Json | Set-Content -LiteralPath $bindingPath -NoNewline
        [pscustomobject]@{
            state = "native_fixture_bootstrapped"
            logicalSaveName = $binding.logicalSaveName
            observedSaveSlot = $binding.observedSaveSlot
            bindingPath = $bindingPath
            contract = "Target-version new-game creation completed and bridge attached. This is an event-free fixture seed, not action success evidence; copy its native save as a read-only template before a disposable action run."
        } | ConvertTo-Json
    } elseif ($Action -eq "equip_tool") {
        $phase = "live_child"
        node $equipToolChild --result-file $actionResultPath --client-config $clientConfig --identity $ScenarioIdentity
        if ($LASTEXITCODE -ne 0) { throw "Native-local package child did not pass." }
        if (-not (Test-Path -LiteralPath $actionResultPath -PathType Leaf)) { throw "Native-local package child produced no private action result." }
    } else {
        $phase = "live_child"
        # Every smoke runner must declare a CLI entry point and print a result; a runner without one
        # imports and exits 0, which used to read as PASS while nothing had run at all (the body-owner gate
        # caught itself this way). The static guard in stardew-native-local-runner-entry.test.mjs covers the
        # tables; this closes the same hole for a DIRECT invocation here.
        $smokeSource = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot $smokeScript)
        if ($smokeSource -notmatch "if \(import\.meta\.main\)") {
            throw "Native-local $smokeScript has no CLI entry point; it would exit 0 while running nothing."
        }
        node (Join-Path $PSScriptRoot $smokeScript) --client-config $clientConfig
        if ($LASTEXITCODE -ne 0) { throw "Native-local $Action smoke did not pass." }
        $evidenceScript = Join-Path $PSScriptRoot "lib\capture-stardew-window-evidence.ps1"
        if (Test-Path -LiteralPath $evidenceScript) {
            & $evidenceScript -ProcessId $process.Id -WindowMode $WindowMode -Tag $WindowMode
        }
    }
} catch {
    $failure = $_
    $failurePhase = $phase
} finally {
    $env:GAMEBUDDY_WINDOW_MODE = $null
    # Restoration must not be bypassed by a failed process-attestation. Capture
    # teardown failure, restore the transaction-owned bytes/lock, then surface
    # the failure. This preserves recovery material only if restore itself
    # fails, per the fixture transaction contract.
    $cleanupFailure = $null
    $cleanupFailurePhase = $null
    try {
        $phase = "process_teardown"
        if ($null -ne $process -and -not $process.HasExited) {
            # The TREE, by exact PID: the game is a separate image this process spawned, so killing only the SMAPI
            # child left `Stardew Valley.exe` running and the NEXT run met it as a busy fixture root with an
            # orphaned transaction (measured repeatedly 2026-10-16/17). Exit status 128 is `taskkill`'s "the
            # process is already gone", which is a legitimate outcome here and the only one tolerated.
            & taskkill /PID $process.Id /T /F *> $null
            if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 128) {
                throw "Native-local process teardown failed for PID $($process.Id) (taskkill exit $LASTEXITCODE)."
            }
            $process.WaitForExit()
        }
        Assert-CannotHaveForgottenOwnGame 'fixture teardown' @($process.Id)
    } catch {
        $cleanupFailure = $_
        $cleanupFailurePhase = $phase
    }
    if ($prelive.enabled -and $null -eq $failure) {
        # RUNG 4, on the way down and never before: the deliberate disconnect is what a teardown-time
        # exception follows from, so the scan window STARTS at the log length captured when the probe closed
        # its client. The process is already gone here, so no later line can enter the window.
        try {
            $phase = "prelive_rung_4_clean_teardown"
            # A rung that cannot be judged is red, never absent: an unscanned teardown would otherwise read
            # as a clean one.
            if ([string]::IsNullOrWhiteSpace($prelive.logPath)) { throw "no Mod log was attributable to this launch, so the disconnect window cannot be scanned" }
            $teardownText = node $preliveLadderTool --mode teardown --log $prelive.logPath --offset $prelive.logOffset
            if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($teardownText)) { throw "Prelive rung 4 could not read the Mod log tail." }
            $teardown = $teardownText | ConvertFrom-Json
            if (-not $teardown.passed) {
                Register-PreliveRungFailure 4 ([string]$teardown.code) ([string]$teardown.detail)
                throw "Prelive rung 4 $($teardown.code): $($teardown.detail)"
            }
            Set-PreliveRung 4 ([string]$teardown.detail)
        } catch {
            # A scan that could not run is not a clean teardown: report it red with the read error.
            Register-PreliveRungFailure 4 (Get-PreliveFailureCode 'dirtyTeardown') $_.Exception.Message
            if ($null -eq $failure) { $failure = $_; $failurePhase = $phase }
        }
    }
    if ($prepared) {
        try {
            $phase = "fixture_restore"
            node (Join-Path $PSScriptRoot "restore-stardew-native-local-player-fixture.mjs") --root $FixtureRoot --mods-path $ModsPath --release-dir $releaseDir --backup-name $backupName
            if ($LASTEXITCODE -ne 0) { throw "Native-local fixture restore failed; transaction remains fail-closed." }
        } catch {
            if ($null -eq $cleanupFailure) {
                $cleanupFailure = $_
                $cleanupFailurePhase = $phase
            }
        }
    }
    if ($workingSavePrepared) {
        try {
            $phase = "working_save_cleanup"
            & $fixtureSaveHarness -FixtureRoot $FixtureRoot -TemplateName $TemplateName -SaveName $SaveName -StardewSaveRoot $stardewSaveRoot -Cleanup
            if ($LASTEXITCODE -ne 0) { throw "Native-local working-save cleanup failed; save recovery requires operator attention." }
        } catch {
            if ($null -eq $cleanupFailure) {
                $cleanupFailure = $_
                $cleanupFailurePhase = $phase
            }
        }
    }
    if ($null -ne $cleanupFailure -and $null -eq $failure) {
        $failure = $cleanupFailure
        $failurePhase = $cleanupFailurePhase
    }
    if ($prelive.enabled) {
        # ONE terminal prelive result, written before the lifecycle claim so a later publication failure
        # cannot lose the rung evidence that says what happened.
        if ($null -ne $failure) { Register-PreliveUnreachedFailure $failurePhase $failure }
        try { Publish-PreliveResult }
        catch {
            if ($null -eq $failure) { $failure = "Prelive result publication failed: $($_.Exception.Message)"; $failurePhase = "prelive_result_publication" }
        }
    }
    if ($null -eq $failure) {
        $phase = "lifecycle_result_publication"
        if (Test-Path -LiteralPath $lifecycleResultPath) { Remove-Item -Force -LiteralPath $lifecycleResultPath -ErrorAction SilentlyContinue }
        node $lifecycleResultWriter --result-file $lifecycleResultPath --state completed
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $lifecycleResultPath -PathType Leaf)) {
            $failure = "Native-local lifecycle cleanup result publication failed."
            $failurePhase = $phase
        }
    }
    if ($null -ne $failure) { Publish-FailureLifecycleResult $failurePhase }
}
if ($null -ne $failure) { throw $failure }
}
