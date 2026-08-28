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
    [switch]$BootstrapNativeSave,
    [ValidateRange(30, 300)][int]$TimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$smapi = Join-Path $GamePath "StardewModdingAPI.exe"
if (-not [IO.Path]::IsPathFullyQualified($ReleaseDir)) { throw "ReleaseDir must be an absolute staged bundle path." }
if (-not [IO.Path]::IsPathFullyQualified($ResultFile)) { throw "ResultFile must be an absolute private result path." }
if (-not [IO.Path]::IsPathFullyQualified($LifecycleResultFile)) { throw "LifecycleResultFile must be an absolute private result path." }
$releaseDir = [IO.Path]::GetFullPath($ReleaseDir).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$actionResultPath = [IO.Path]::GetFullPath($ResultFile)
$lifecycleResultPath = [IO.Path]::GetFullPath($LifecycleResultFile)
if ($actionResultPath -eq $lifecycleResultPath) { throw "Action and lifecycle result files must be separate." }
if (Test-Path -LiteralPath $actionResultPath) { throw "Action result file must be initially absent." }
if (Test-Path -LiteralPath $lifecycleResultPath) { throw "Lifecycle result file must be initially absent." }
$packageRoot = Join-Path (Join-Path $PSScriptRoot "..") "integrations/stardew/action-development"
$equipToolChild = Join-Path $packageRoot "scenarios/equip-tool-live-child.mjs"
$lifecycleResultWriter = Join-Path $packageRoot "scenarios/write-lifecycle-result.mjs"
$clientConfig = Join-Path $ModsPath "GameBuddy/config.json"
$backupName = "native-local-$($Action.Replace('_', '-'))-fixture-backup"
$fixtureSaveHarness = Join-Path $PSScriptRoot "prepare-stardew-action-fixture.ps1"
$stardewSaveRoot = Join-Path $env:APPDATA "StardewValley\Saves"
$pipeReadinessHelper = Join-Path $PSScriptRoot "lib/stardew-named-pipe-readiness.ps1"
. $pipeReadinessHelper
$runnerResolver = Join-Path $PSScriptRoot "resolve-stardew-action-gate-runner.mjs"
$smokeScript = node $runnerResolver --action $Action
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($smokeScript)) { throw "Native-local action runner resolution failed for '$Action'." }
$smokeScript = $smokeScript.Trim()
if ($smokeScript -notmatch '^run-stardew-native-local-player-[a-z0-9-]+-smoke\.mjs$') { throw "Native-local action runner resolution returned an invalid runner identity." }
if ($Action -eq "equip_tool") {
    if ([string]::IsNullOrWhiteSpace($ScenarioIdentity)) { throw "equip_tool requires ScenarioIdentity." }
    try { $null = $ScenarioIdentity | ConvertFrom-Json } catch { throw "ScenarioIdentity must be valid JSON." }
}
foreach ($path in @($smapi, $ModsPath, $FixtureRoot, $releaseDir, $clientConfig, $equipToolChild, $lifecycleResultWriter)) { if (-not (Test-Path -LiteralPath $path)) { throw "Missing harness path: $path" } }
if (-not $BootstrapNativeSave -and $SaveName -notmatch '^GameBuddyFixture[A-Za-z0-9]{0,64}_[0-9]{1,32}$') { throw "A disposable action run requires an observed physical GameBuddyFixture slot ending in _<nativeUniqueId>." }

function Assert-NoStardewProcesses([string]$Phase) {
    $running = @(Get-Process -Name 'StardewModdingAPI','Stardew Valley','StardewValley' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        $ids = ($running | ForEach-Object Id) -join ','
        throw "Native-local fixture requires no pre-existing Stardew/SMAPI process before $Phase (PIDs: $ids)."
    }
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
    if ($running.Count -ne 1) {
        $ids = ($running | ForEach-Object ProcessId) -join ','
        throw "Native-local launch identity requires exactly one SMAPI process after pipe readiness (PIDs: $ids)."
    }
    $actual = $running[0]
    if ($actual.ProcessId -ne $ExpectedProcessId) {
        throw "Native-local launch identity mismatch: running SMAPI is not the exact process launched by this transaction; no bridge action was sent."
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

# This guard precedes every profile/config/bundle mutation. The one process
# launched below is therefore the only game process in this transaction.
Assert-NoStardewProcesses 'fixture preparation'

$prepared = $false
$workingSavePrepared = $false
$process = $null
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
        node (Join-Path $PSScriptRoot "prepare-stardew-native-local-player-fixture.mjs") --root $FixtureRoot --mods-path $ModsPath --release-dir $releaseDir --save-name $SaveName --backup-name $backupName --timeout-seconds $TimeoutSeconds --action $Action --binding-path $bindingPath
        if ($LASTEXITCODE -ne 0) { throw "Native-local fixture prepare failed." }
    }
    $prepared = $true
    if (-not $BootstrapNativeSave) {
        # Restore an external, native-created template byte-for-byte as this
        # transaction's disposable observed-slot working save. No XML/save-state
        # patch is performed, and cleanup below removes only this exact slot.
        & $fixtureSaveHarness -FixtureRoot $FixtureRoot -TemplateName $TemplateName -SaveName $SaveName -StardewSaveRoot $stardewSaveRoot
        if ($LASTEXITCODE -ne 0) { throw "Native-local working-save restore failed." }
        $workingSavePrepared = $true
    }
    # Start-Process joins ArgumentList tokens itself. Quote the custom path so its
    # embedded `Stardew Valley` space cannot truncate SMAPI's --mods-path value.
    $process = Start-Process -FilePath $smapi -ArgumentList @("--mods-path", ('"{0}"' -f $ModsPath)) -WorkingDirectory $GamePath -PassThru
    $pipeName = (Get-Content -Raw -LiteralPath $clientConfig | ConvertFrom-Json).PipeName
    if ([string]::IsNullOrWhiteSpace($pipeName)) { throw "Native-local fixture config has no pipe name." }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while (-not (Test-GameBuddyNamedPipeListening -PipeName $pipeName)) {
        Start-Sleep -Milliseconds 250
        if ($process.HasExited) { throw "Native-local SMAPI process exited before bridge smoke." }
        if ([DateTime]::UtcNow -ge $deadline) { throw "Native-local bridge pipe was not ready before timeout." }
    }
    Assert-LaunchedSmapiIdentity -ExpectedSmapi $smapi -ExpectedModsPath $ModsPath -ExpectedProcessId $process.Id
    $liveFixture = Get-Content -Raw -LiteralPath $clientConfig | ConvertFrom-Json
    if ($BootstrapNativeSave) {
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
        node $equipToolChild --result-file $actionResultPath --client-config $clientConfig --identity $ScenarioIdentity
        if ($LASTEXITCODE -ne 0) { throw "Native-local package child did not pass." }
        if (-not (Test-Path -LiteralPath $actionResultPath -PathType Leaf)) { throw "Native-local package child produced no private action result." }
    } else {
        node (Join-Path $PSScriptRoot $smokeScript) --client-config $clientConfig
        if ($LASTEXITCODE -ne 0) { throw "Native-local $Action smoke did not pass." }
    }
} finally {
    # Restoration must not be bypassed by a failed process-attestation. Capture
    # teardown failure, restore the transaction-owned bytes/lock, then surface
    # the failure. This preserves recovery material only if restore itself
    # fails, per the fixture transaction contract.
    $cleanupFailure = $null
    try {
        if ($null -ne $process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force; $process.WaitForExit() }
        Assert-NoStardewProcesses 'fixture teardown'
    } catch {
        $cleanupFailure = $_
    }
    if ($prepared) {
        try {
            node (Join-Path $PSScriptRoot "restore-stardew-native-local-player-fixture.mjs") --root $FixtureRoot --mods-path $ModsPath --release-dir $releaseDir --backup-name $backupName
            if ($LASTEXITCODE -ne 0) { throw "Native-local fixture restore failed; transaction remains fail-closed." }
        } catch {
            if ($null -eq $cleanupFailure) { $cleanupFailure = $_ }
        }
    }
    if ($workingSavePrepared) {
        try {
            & $fixtureSaveHarness -FixtureRoot $FixtureRoot -TemplateName $TemplateName -SaveName $SaveName -StardewSaveRoot $stardewSaveRoot -Cleanup
            if ($LASTEXITCODE -ne 0) { throw "Native-local working-save cleanup failed; save recovery requires operator attention." }
        } catch {
            if ($null -eq $cleanupFailure) { $cleanupFailure = $_ }
        }
    }
    if ($null -ne $cleanupFailure) { throw $cleanupFailure }
    node $lifecycleResultWriter --result-file $lifecycleResultPath --state completed
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $lifecycleResultPath -PathType Leaf)) {
        throw "Native-local lifecycle cleanup result publication failed."
    }
}
