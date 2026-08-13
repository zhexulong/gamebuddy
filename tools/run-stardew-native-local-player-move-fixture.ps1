[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$GamePath,
    [Parameter(Mandatory = $true)][string]$ModsPath,
    [Parameter(Mandatory = $true)][string]$FixtureRoot,
    [Parameter(Mandatory = $true)][string]$SaveName,
    [ValidateSet("move_to_tile", "tree_discovery", "tree_first_hit", "chop_tree_source", "break_rock_source", "clear_hoedirt", "dig_artifact_spot", "refill_watering_can", "feed_animal", "collect_animal_product", "travel", "clear_debris", "enter_exit", "equip_tool", "till_soil", "water_crop", "plant_seed", "fertilize_tile", "harvest_crop", "pickup_forage", "pickup_item", "machine_inspect", "machine_load", "machine_collect_output", "npc_relationship", "pet_animal", "use_item", "place_wood_fence", "place_crab_pot", "bait_crab_pot")][string]$Action = "move_to_tile",
    [switch]$BootstrapNativeSave,
    [ValidateRange(30, 300)][int]$TimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$smapi = Join-Path $GamePath "StardewModdingAPI.exe"
$releaseDir = Join-Path $projectRoot "integrations/stardew/bin/Release/net6.0"
$clientConfig = Join-Path $ModsPath "GameBuddy/config.json"
$backupName = "native-local-$($Action.Replace('_', '-'))-fixture-backup"
$fixtureSaveHarness = Join-Path $PSScriptRoot "prepare-stardew-action-fixture.ps1"
$stardewSaveRoot = Join-Path $env:APPDATA "StardewValley\Saves"
$smokeScript = switch ($Action) {
    "tree_discovery" { "run-stardew-native-local-player-tree-discovery-probe.mjs" }
    "tree_first_hit" { "run-stardew-native-local-player-tree-first-hit-smoke.mjs" }
    "chop_tree_source" { "run-stardew-native-local-player-chop-tree-source-smoke.mjs" }
    "break_rock_source" { "run-stardew-native-local-player-break-rock-source-smoke.mjs" }
    "clear_hoedirt" { "run-stardew-native-local-player-clear-hoedirt-smoke.mjs" }
    "dig_artifact_spot" { "run-stardew-native-local-player-dig-artifact-spot-smoke.mjs" }
    "clear_debris" { "run-stardew-native-local-player-clear-debris-smoke.mjs" }
    "refill_watering_can" { "run-stardew-native-local-player-refill-watering-can-smoke.mjs" }
    "feed_animal" { "run-stardew-native-local-player-feed-animal-smoke.mjs" }
    "collect_animal_product" { "run-stardew-native-local-player-collect-animal-product-smoke.mjs" }
    "travel" { "run-stardew-native-local-player-travel-smoke.mjs" }
    "enter_exit" { "run-stardew-native-local-player-enter-exit-smoke.mjs" }
    "equip_tool" { "run-stardew-native-local-player-equip-tool-smoke.mjs" }
    "till_soil" { "run-stardew-native-local-player-till-soil-smoke.mjs" }
    "water_crop" { "run-stardew-native-local-player-water-crop-smoke.mjs" }
    "plant_seed" { "run-stardew-native-local-player-plant-seed-smoke.mjs" }
    "fertilize_tile" { "run-stardew-native-local-player-fertilize-tile-smoke.mjs" }
    "harvest_crop" { "run-stardew-native-local-player-harvest-crop-smoke.mjs" }
    "pickup_forage" { "run-stardew-native-local-player-pickup-forage-smoke.mjs" }
    "pickup_item" { "run-stardew-native-local-player-pickup-item-smoke.mjs" }
    "machine_inspect" { "run-stardew-machine-inspect-fixture-smoke.mjs" }
    "machine_load" { "run-stardew-native-local-player-machine-load-smoke.mjs" }
    "machine_collect_output" { "run-stardew-native-local-player-machine-collect-output-smoke.mjs" }
    "npc_relationship" { "run-stardew-native-local-player-npc-relationship-smoke.mjs" }
    "pet_animal" { "run-stardew-native-local-player-pet-animal-smoke.mjs" }
    "use_item" { "run-stardew-native-local-player-use-item-smoke.mjs" }
    "place_wood_fence" { "run-stardew-native-local-player-place-wood-fence-smoke.mjs" }
    "place_crab_pot" { "run-stardew-native-local-player-place-crab-pot-smoke.mjs" }
    "bait_crab_pot" { "run-stardew-native-local-player-bait-crab-pot-smoke.mjs" }
    default { "run-stardew-native-local-player-move-smoke.mjs" }
}
foreach ($path in @($smapi, $ModsPath, $FixtureRoot, $releaseDir, $clientConfig)) { if (-not (Test-Path -LiteralPath $path)) { throw "Missing harness path: $path" } }
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

function Assert-LaunchedSmapiIdentity([string]$ExpectedSmapi, [string]$ExpectedModsPath) {
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
        & $fixtureSaveHarness -FixtureRoot $FixtureRoot -TemplateName $SaveName -SaveName $SaveName -StardewSaveRoot $stardewSaveRoot
        if ($LASTEXITCODE -ne 0) { throw "Native-local working-save restore failed." }
        $workingSavePrepared = $true
    }
    # Start-Process joins ArgumentList tokens itself. Quote the custom path so its
    # embedded `Stardew Valley` space cannot truncate SMAPI's --mods-path value.
    $process = Start-Process -FilePath $smapi -ArgumentList @("--mods-path", ('"{0}"' -f $ModsPath)) -WorkingDirectory $GamePath -PassThru
    $pipeName = (Get-Content -Raw -LiteralPath $clientConfig | ConvertFrom-Json).PipeName
    if ([string]::IsNullOrWhiteSpace($pipeName)) { throw "Native-local fixture config has no pipe name." }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while (-not (Test-Path -LiteralPath "\\.\pipe\$pipeName")) {
        Start-Sleep -Milliseconds 250
        if ($process.HasExited) { throw "Native-local SMAPI process exited before bridge smoke." }
        if ([DateTime]::UtcNow -ge $deadline) { throw "Native-local bridge pipe was not ready before timeout." }
    }
    Assert-LaunchedSmapiIdentity -ExpectedSmapi $smapi -ExpectedModsPath $ModsPath
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
    } else {
        node (Join-Path $PSScriptRoot $smokeScript) --client-config $clientConfig
        if ($LASTEXITCODE -ne 0) { throw "Native-local $Action smoke did not pass." }
    }
} finally {
    # Restoration must not be bypassed by a failed process-attestation. Capture
    # teardown failure, restore the transaction-owned bytes/lock, then surface
    # the failure. This preserves recovery material only if restore itself
    # fails, per the fixture transaction contract.
    $teardownFailure = $null
    try {
        if ($null -ne $process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force; $process.WaitForExit() }
        Assert-NoStardewProcesses 'fixture teardown'
    } catch {
        $teardownFailure = $_
    }
    if ($prepared) {
        node (Join-Path $PSScriptRoot "restore-stardew-native-local-player-fixture.mjs") --root $FixtureRoot --mods-path $ModsPath --release-dir $releaseDir --backup-name $backupName
        if ($LASTEXITCODE -ne 0) { throw "Native-local fixture restore failed; transaction remains fail-closed." }
    }
    if ($workingSavePrepared) {
        & $fixtureSaveHarness -FixtureRoot $FixtureRoot -TemplateName $SaveName -SaveName $SaveName -StardewSaveRoot $stardewSaveRoot -Cleanup
        if ($LASTEXITCODE -ne 0) { throw "Native-local working-save cleanup failed; save recovery requires operator attention." }
    }
    if ($null -ne $teardownFailure) { throw $teardownFailure }
}
