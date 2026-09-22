<##
.SYNOPSIS
    Builds or runs the Stardew headless Farmhand animation-driver probe charter.

.DESCRIPTION
    This is an evidence-only wrapper. In its default mode it validates the
    optional paths and prints a bounded probe plan; it never starts Stardew.
    With -RunLive it starts the requested SMAPI profile and delegates action
    dispatch and frame sampling to an existing authenticated bridge/test
    harness supplied through -BridgePath. The delegated harness must use the
    existing bridge semantics and must write the bounded evidence document
    described by the companion markdown file.

    This script never calls a Stardew handler, edits a save, writes a world
    object, injects input, or treats process/transport success as action
    success.

.PARAMETER GamePath
    Optional absolute Stardew Valley installation path. Required with -RunLive.

.PARAMETER ProfilePath
    Optional absolute SMAPI mods/profile path. Required with -RunLive.

.PARAMETER SaveSlot
    Optional observed save slot. Required with -RunLive. The harness owns save
    admission and must not use a different slot.

.PARAMETER BridgePath
    Optional existing authenticated bridge/test-harness adapter. Required with
    -RunLive. It receives --probe-spec <path> and writes the evidence path from
    that spec; it must trigger actions through the existing bridge, not by
    mutating the game directly.

.PARAMETER Action
    Action family to include in the charter. The default is all three probe
    actions: till_soil, water_crop, and chop_tree_source.

.PARAMETER TimeoutSeconds
    Per-action watchdog budget advertised to the harness. This is an evidence
    timeout, not a gameplay quota or a new Mod deadline.

.PARAMETER EvidencePath
    Optional absolute path for the harness-produced evidence document. In live
    mode an omitted path is allocated below the user temporary directory.

.PARAMETER RunLive
    Start SMAPI and invoke the supplied existing bridge/test harness. Omit this
    switch for the safe plan-only mode used by local checks.

.EXAMPLE
    pwsh -NoProfile -File tools/stardew-headless-animation-driver-probe.ps1

.EXAMPLE
    pwsh -NoProfile -File tools/stardew-headless-animation-driver-probe.ps1 `
      -RunLive -GamePath 'D:\Steam\steamapps\common\Stardew Valley' `
      -ProfilePath 'D:\GameBuddy\animation-probe-profile' `
      -SaveSlot 'GameBuddyFixtureAnimation_1' `
      -BridgePath 'D:\GameBuddy\existing-authenticated-animation-harness.ps1' `
      -EvidencePath 'D:\GameBuddy\evidence\animation-driver.json'

.NOTES
    Target version: Stardew Valley 1.6.15.24356 / SMAPI 4.5.2.
    The companion .md is the charter and the authority-boundary description.
#>
[CmdletBinding()]
param(
    [Alias('Game')]
    [string]$GamePath,

    [Alias('Profile')]
    [string]$ProfilePath,

    [Alias('Save')]
    [ValidatePattern('^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$')]
    [string]$SaveSlot,

    [Alias('Bridge')]
    [string]$BridgePath,

    [ValidateSet('all', 'till_soil', 'water_crop', 'chop_tree_source')]
    [string]$Action = 'all',

    [ValidateRange(10, 900)]
    [int]$TimeoutSeconds = 60,

    [Alias('Output')]
    [string]$EvidencePath,

    [switch]$RunLive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$targetVersion = [ordered]@{
    stardew = '1.6.15.24356'
    smapi = '4.5.2'
}

function Get-SelectedActions {
    if ($Action -eq 'all') {
        return @('till_soil', 'water_crop', 'chop_tree_source')
    }
    return @($Action)
}

function Resolve-OptionalAbsolutePath {
    param([string]$Value, [string]$Name, [switch]$MustExist)

    if ([string]::IsNullOrWhiteSpace($Value)) {
        return $null
    }
    if (-not [IO.Path]::IsPathFullyQualified($Value)) {
        throw "${Name}_must_be_absolute"
    }
    $resolved = [IO.Path]::GetFullPath($Value)
    if ($MustExist -and -not (Test-Path -LiteralPath $resolved)) {
        throw "${Name}_not_found"
    }
    return $resolved
}

function Get-EvidencePath {
    param([string]$RequestedPath)

    if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
        $resolved = Resolve-OptionalAbsolutePath -Value $RequestedPath -Name 'evidence_path'
        $parent = [IO.Path]::GetDirectoryName($resolved)
        if ([string]::IsNullOrWhiteSpace($parent)) {
            throw 'evidence_path_parent_missing'
        }
        if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
            New-Item -ItemType Directory -Force -Path $parent | Out-Null
        }
        return $resolved
    }

    $nonce = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    return Join-Path ([IO.Path]::GetTempPath()) "gamebuddy-stardew-animation-driver-$nonce.json"
}

function New-ProbePlan {
    param([string]$ResolvedEvidencePath)

    $actions = Get-SelectedActions
    return [ordered]@{
        schema = 'stardew-headless-animation-driver-probe/v1'
        authority = 'evidence_only'
        mode = if ($RunLive) { 'live_delegated' } else { 'plan_only' }
        targetVersion = $targetVersion
        topology = [ordered]@{
            kind = 'native_ai_farmhand_multiplayer'
            driver = 'host_driven'
            physicalInput = 'none'
            worldMutationAuthority = 'existing_authenticated_bridge_and_mod_only'
        }
        actions = $actions
        saveSlot = if ([string]::IsNullOrWhiteSpace($SaveSlot)) { $null } else { $SaveSlot }
        profilePath = if ([string]::IsNullOrWhiteSpace($ProfilePath)) { $null } else { [IO.Path]::GetFullPath($ProfilePath) }
        bridgePath = if ([string]::IsNullOrWhiteSpace($BridgePath)) { $null } else { [IO.Path]::GetFullPath($BridgePath) }
        evidencePath = $ResolvedEvidencePath
        sequence = @(
            'verify target version, profile, save identity, and authenticated bridge scope',
            'launch the exact SMAPI profile only when live mode is explicitly requested',
            'trigger one selected action through the existing bridge or test harness semantics',
            'sample UsingTool and animation-frame state on every UpdateTicked observation',
            'record the native Apex callback and action-owned effect evidence',
            'wait for UsingTool=false and actor-idle recovery under the bounded watchdog',
            'write one redacted evidence table; timeout or missing correlation is blocked'
        )
        observation = [ordered]@{
            usingTool = @('false_before_dispatch', 'true_after_begin', 'false_after_native_finish')
            animationFrames = 'ordered UpdateTicked frame sequence with timestamps or monotonic frame indexes'
            apex = 'one correlated native Apex callback for the same action attempt'
            completion = 'UsingTool=false plus action-owned receipt/evidence/postcondition'
            missingInput = 'no keyboard/gamepad release event is injected or assumed'
        }
        watchdog = [ordered]@{
            timeoutSeconds = $TimeoutSeconds
            rule = 'UsingTool remains true, Apex is absent, or finish cannot be correlated before the deadline => blocked/deadlock_or_timeout'
            recovery = 'do not force-reset UsingTool, retry, or claim cancellation/completion'
        }
        bridgeContract = [ordered]@{
            dispatch = 'existing authenticated bridge/test harness only'
            invocation = '--probe-spec <path-to-this-plan-json>'
            requiredOutput = 'stardew-headless-animation-driver-evidence/v1 at evidencePath'
            forbidden = @('direct C# handler invocation', 'direct world mutation', 'raw save editing', 'synthetic success receipt')
        }
        evidence = @(
            foreach ($probeAction in $actions) {
                [ordered]@{
                    action = $probeAction
                    status = 'not_run'
                    usingToolFrames = @()
                    apex = $null
                    nativeEffect = $null
                    terminalReceipt = $null
                    usingToolReturned = $null
                    watchdog = 'not_run'
                    verdict = '未运行'
                    evidenceRef = $null
                }
            }
        )
        minimumReproduction = @(
            'Use the exact target-version game and SMAPI pair above.',
            'Prepare a legal live target through the existing fixture/harness; do not write the final target result during setup.',
            'Authenticate the Farmhand bridge and submit exactly one action request per row.',
            'Capture per-UpdateTicked UsingTool/frame observations, the correlated Apex callback, and the fresh action postcondition.',
            'Repeat each action at least once without physical input; classify any missing finish as deadlock_or_timeout.'
        )
    }
}

$resolvedGamePath = Resolve-OptionalAbsolutePath -Value $GamePath -Name 'game_path'
$resolvedProfilePath = Resolve-OptionalAbsolutePath -Value $ProfilePath -Name 'profile_path'
$resolvedBridgePath = Resolve-OptionalAbsolutePath -Value $BridgePath -Name 'bridge_path'
$resolvedEvidencePath = if ($RunLive) { Get-EvidencePath -RequestedPath $EvidencePath } else { $EvidencePath }

if (-not $RunLive) {
    $plan = New-ProbePlan -ResolvedEvidencePath $resolvedEvidencePath
    $plan | ConvertTo-Json -Depth 12
    exit 0
}

if ([string]::IsNullOrWhiteSpace($resolvedGamePath) -or
    [string]::IsNullOrWhiteSpace($resolvedProfilePath) -or
    [string]::IsNullOrWhiteSpace($SaveSlot) -or
    [string]::IsNullOrWhiteSpace($resolvedBridgePath)) {
    throw 'run_live_requires_game_profile_save_and_bridge_paths'
}

if (-not (Test-Path -LiteralPath $resolvedGamePath -PathType Container)) {
    throw 'game_path_not_directory'
}
if (-not (Test-Path -LiteralPath $resolvedProfilePath -PathType Container)) {
    throw 'profile_path_not_directory'
}
if (-not (Test-Path -LiteralPath $resolvedBridgePath -PathType Leaf)) {
    throw 'bridge_path_not_file'
}

$smapiPath = Join-Path $resolvedGamePath 'StardewModdingAPI.exe'
if (-not (Test-Path -LiteralPath $smapiPath -PathType Leaf)) {
    throw 'stardew_modding_api_not_found'
}

$plan = New-ProbePlan -ResolvedEvidencePath $resolvedEvidencePath
$specPath = Join-Path ([IO.Path]::GetTempPath()) "gamebuddy-stardew-animation-driver-spec-$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).json"
$process = $null
try {
    [IO.File]::WriteAllText(
        $specPath,
        ($plan | ConvertTo-Json -Depth 12),
        [Text.UTF8Encoding]::new($false)
    )

    $process = Start-Process `
        -FilePath $smapiPath `
        -ArgumentList @('--mods-path', ('"{0}"' -f $resolvedProfilePath)) `
        -WorkingDirectory $resolvedGamePath `
        -PassThru

    $bridgeExtension = [IO.Path]::GetExtension($resolvedBridgePath).ToLowerInvariant()
    if ($bridgeExtension -eq '.ps1') {
        $runnerOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $resolvedBridgePath '--probe-spec' $specPath 2>&1 | Out-String
    } elseif ($bridgeExtension -eq '.mjs') {
        $runnerOutput = & node $resolvedBridgePath '--probe-spec' $specPath 2>&1 | Out-String
    } else {
        $runnerOutput = & $resolvedBridgePath '--probe-spec' $specPath 2>&1 | Out-String
    }
    $runnerExitCode = $LASTEXITCODE
    if ($runnerExitCode -ne 0) {
        [pscustomobject]@{
            schema = 'stardew-headless-animation-driver-evidence/v1'
            status = 'blocked'
            reason = 'bridge_harness_failed'
            runnerExitCode = $runnerExitCode
            evidence = @()
        } | ConvertTo-Json -Depth 8
        exit 2
    }

    if (-not (Test-Path -LiteralPath $resolvedEvidencePath -PathType Leaf)) {
        [pscustomobject]@{
            schema = 'stardew-headless-animation-driver-evidence/v1'
            status = 'blocked'
            reason = 'animation_evidence_missing'
            evidence = @()
        } | ConvertTo-Json -Depth 8
        exit 2
    }

    $evidence = Get-Content -Raw -LiteralPath $resolvedEvidencePath | ConvertFrom-Json
    if ($null -eq $evidence -or $evidence.schema -ne 'stardew-headless-animation-driver-evidence/v1') {
        throw 'animation_evidence_schema_invalid'
    }
    $evidence | ConvertTo-Json -Depth 12
    if ($evidence.status -ne 'passed') {
        exit 2
    }
}
finally {
    if ($null -ne $process) {
        $process.Refresh()
        if (-not $process.HasExited) {
            try { $process.CloseMainWindow() | Out-Null } catch { }
            Start-Sleep -Seconds 2
            $process.Refresh()
            if (-not $process.HasExited) {
                Stop-Process -Id $process.Id -Force
                $process.WaitForExit()
            }
        }
    }
    if (Test-Path -LiteralPath $specPath -PathType Leaf) {
        Remove-Item -LiteralPath $specPath -Force -ErrorAction SilentlyContinue
    }
}
