[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$GamePath,
    [Parameter(Mandatory = $true)][string]$ModsPath,
    [Parameter(Mandatory = $true)][string]$FixtureRoot,
    [Parameter(Mandatory = $true)][string]$SaveName,
    [Parameter(Mandatory = $true)][string]$TemplateName,
    [Parameter(Mandatory = $true)][string]$ReleaseDir,
    [Parameter(Mandatory = $true)][string]$EvidencePath,
    [Parameter(Mandatory = $true)][ValidateSet('p1_readonly', 'p2_answer', 'lifecycle', 'pass_out_lifecycle')][string]$Mode,
    [string]$WindowMode = "hidden",
    [ValidateRange(30, 300)][int]$TimeoutSeconds = 150
)

# M2 sleep-modal probe runner.
#
# This is a dedicated, evidence-only launcher for the M2 seam probe
# (design/tasks/active/loop-m2-cross-day-seam-decision.md §11.2 obligation 4).
# It reuses the existing native-local fixture transaction (prepare/deploy/restore)
# but never sends a bridge action: the Mod-side SleepModalProbe owns the actor's
# route, observes the game-owned DialogueBox, and (in p2_answer mode) answers
# through the public native entry. The runner only waits for the probe's evidence
# file and surfaces it.
#
# p2_answer necessarily advances the day, so it must only run on a disposable
# working save derived from an external template.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$smapi = Join-Path $GamePath "StardewModdingAPI.exe"
$clientConfig = Join-Path $ModsPath "GameBuddy.Stardew/config.json"
$backupName = "native-local-sleep-modal-fixture-backup"
$fixtureSaveHarness = Join-Path $PSScriptRoot "prepare-stardew-action-fixture.ps1"
$stardewSaveRoot = Join-Path $env:APPDATA "StardewValley\Saves"
$pipeReadinessHelper = Join-Path $PSScriptRoot "lib/stardew-named-pipe-readiness.ps1"
. $pipeReadinessHelper

function Assert-NoStardewProcesses([string]$Phase) {
    $running = @(Get-Process -Name 'StardewModdingAPI','Stardew Valley','StardewValley' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        $ids = ($running | ForEach-Object Id) -join ','
        throw "Sleep-modal probe requires no pre-existing Stardew/SMAPI process before $Phase (PIDs: $ids)."
    }
}

if (-not [IO.Path]::IsPathFullyQualified($ReleaseDir)) { throw "ReleaseDir must be an absolute staged bundle path." }
if (-not [IO.Path]::IsPathFullyQualified($EvidencePath)) { throw "EvidencePath must be absolute." }
if ($SaveName -notmatch '^GameBuddyFixture[A-Za-z0-9]{0,64}_[0-9]{1,32}$') {
    throw "A disposable probe run requires an observed physical GameBuddyFixture slot ending in _<nativeUniqueId>."
}
$releaseDir = [IO.Path]::GetFullPath($ReleaseDir).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$evidenceFull = [IO.Path]::GetFullPath($EvidencePath)
if (Test-Path -LiteralPath $evidenceFull) { Remove-Item -Force -LiteralPath $evidenceFull -ErrorAction SilentlyContinue }
foreach ($path in @($smapi, $ModsPath, $FixtureRoot, $releaseDir, $clientConfig, $fixtureSaveHarness)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing harness path: $path" }
}
Assert-NoStardewProcesses 'fixture preparation'

$prepared = $false
$workingSavePrepared = $false
$process = $null
$phase = "fixture_prepare"
try {
    $bindingPath = Get-ChildItem -LiteralPath $FixtureRoot -Filter '*.native-local-binding.json' -File | Where-Object {
        try { (Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json).observedSaveSlot -eq $SaveName } catch { $false }
    } | Select-Object -First 1 -ExpandProperty FullName
    if ([string]::IsNullOrWhiteSpace($bindingPath)) {
        throw "Sleep-modal probe requires a bootstrap-captured binding whose observed slot is $SaveName."
    }
    $prepareArgs = @(
        '--root', $FixtureRoot, '--mods-path', $ModsPath, '--release-dir', $releaseDir,
        '--save-name', $SaveName, '--backup-name', $backupName, '--timeout-seconds', $TimeoutSeconds,
        '--binding-path', $bindingPath, '--stardew-save-root', $stardewSaveRoot
    )
    if ($Mode -eq 'lifecycle') {
        $prepareArgs += @('--action', 'sleep_lifecycle', '--sleep-lifecycle-evidence', $evidenceFull)
    } elseif ($Mode -eq 'pass_out_lifecycle') {
        # The pass-out variant establishes only a low-stamina precondition; the
        # native gate starts the pass-out itself and the lifecycle only observes.
        $prepareArgs += @('--action', 'sleep_pass_out_lifecycle', '--sleep-lifecycle-evidence', $evidenceFull)
    } else {
        $prepareArgs += @('--action', 'sleep_modal_probe', '--sleep-modal-probe-mode', $Mode, '--sleep-modal-probe-evidence', $evidenceFull)
    }
    node (Join-Path $PSScriptRoot "prepare-stardew-native-local-player-fixture.mjs") @prepareArgs
    if ($LASTEXITCODE -ne 0) { throw "Sleep-modal probe fixture prepare failed." }
    $prepared = $true

    $phase = "working_save_restore"
    & $fixtureSaveHarness -FixtureRoot $FixtureRoot -TemplateName $TemplateName -SaveName $SaveName -StardewSaveRoot $stardewSaveRoot
    if ($LASTEXITCODE -ne 0) { throw "Sleep-modal probe working-save restore failed." }
    $workingSavePrepared = $true

    $phase = "smapi_launch"
    $env:GAMEBUDDY_WINDOW_MODE = $WindowMode
    $windowStyle = if ($WindowMode -eq "hidden") { "Hidden" } else { "Normal" }
    $process = Start-Process -FilePath $smapi -ArgumentList @("--mods-path", ('"{0}"' -f $ModsPath)) -WorkingDirectory $GamePath -WindowStyle $windowStyle -PassThru

    $pipeName = (Get-Content -Raw -LiteralPath $clientConfig | ConvertFrom-Json).PipeName
    if ([string]::IsNullOrWhiteSpace($pipeName)) { throw "Sleep-modal probe config has no pipe name." }
    $phase = "pipe_readiness"
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while (-not (Test-GameBuddyNamedPipeListening -PipeName $pipeName)) {
        Start-Sleep -Milliseconds 250
        if ($process.HasExited) { throw "SMAPI exited before the sleep-modal probe produced evidence." }
        if ([DateTime]::UtcNow -ge $deadline) { throw "Bridge pipe was not ready before timeout." }
    }

    $phase = "probe_evidence"
    while (-not (Test-Path -LiteralPath $evidenceFull -PathType Leaf)) {
        Start-Sleep -Milliseconds 250
        if ($process.HasExited) {
            if (Test-Path -LiteralPath $evidenceFull -PathType Leaf) { break }
            throw "SMAPI exited before the sleep-modal probe wrote evidence."
        }
        if ([DateTime]::UtcNow -ge $deadline) { throw "Sleep-modal probe wrote no evidence before timeout." }
    }

    $evidence = Get-Content -Raw -LiteralPath $evidenceFull | ConvertFrom-Json
    $schema = if ($Mode -in @('lifecycle', 'pass_out_lifecycle')) { 'gamebuddy-sleep-lifecycle/v1' } else { 'gamebuddy-sleep-modal-probe/v1' }
    if ($null -eq $evidence -or $evidence.schema -ne $schema) {
        throw "Sleep-modal probe evidence schema is invalid."
    }
    $evidence | ConvertTo-Json -Depth 12
} finally {
    $env:GAMEBUDDY_WINDOW_MODE = $null
    try {
        if ($null -ne $process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force; $process.WaitForExit() }
        Assert-NoStardewProcesses 'probe teardown'
    } catch {}
    if ($prepared) {
        try {
            node (Join-Path $PSScriptRoot "restore-stardew-native-local-player-fixture.mjs") --root $FixtureRoot --mods-path $ModsPath --release-dir $releaseDir --backup-name $backupName
        } catch {}
    }
    if ($workingSavePrepared) {
        try {
            & $fixtureSaveHarness -FixtureRoot $FixtureRoot -TemplateName $TemplateName -SaveName $SaveName -StardewSaveRoot $stardewSaveRoot -Cleanup
        } catch {}
    }
}
