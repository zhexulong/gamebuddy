[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$GamePath,
    [Parameter(Mandatory = $true)][string]$ModsPath,
    [Parameter(Mandatory = $true)][string]$FixtureRoot,
    [Parameter(Mandatory = $true)][string]$SaveName,
    [ValidateRange(30, 300)][int]$TimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$smapi = Join-Path $GamePath "StardewModdingAPI.exe"
$releaseDir = Join-Path $projectRoot "integrations/stardew/bin/Release/net6.0"
$clientConfig = Join-Path $ModsPath "GameBuddy/config.json"
$backupName = "native-local-navigation-read-only-fixture-backup"
$fixtureSaveHarness = Join-Path $PSScriptRoot "prepare-stardew-action-fixture.ps1"
$bootstrapHarness = Join-Path $PSScriptRoot "run-stardew-native-local-player-move-fixture.ps1"
. (Join-Path $PSScriptRoot "lib/stardew-named-pipe-readiness.ps1")
$stardewSaveRoot = Join-Path $env:APPDATA "StardewValley\Saves"
$gateScript = Join-Path $PSScriptRoot "stardew-navigation-read-only-direct-gate.mjs"

foreach ($path in @($smapi, $ModsPath, $FixtureRoot, $releaseDir, $clientConfig, $gateScript)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing harness path: $path" }
}
if ($SaveName -notmatch '^GameBuddyFixture[A-Za-z0-9]{0,64}_[0-9]{1,32}$') {
    throw "Navigation read-only gate requires an observed physical GameBuddyFixture slot ending in _<nativeUniqueId>."
}

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
    $expectedSmapiPath = Get-NormalizedWindowsPath $ExpectedSmapi
    $expectedModsPath = Get-NormalizedWindowsPath $ExpectedModsPath
    $running = @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object { $_.Name -ieq 'StardewModdingAPI.exe' })
    if ($running.Count -ne 1) { throw "Native-local launch identity requires exactly one SMAPI process after pipe readiness." }
    $actual = $running[0]
    if ([string]::IsNullOrWhiteSpace($actual.ExecutablePath) -or -not [string]::Equals((Get-NormalizedWindowsPath $actual.ExecutablePath), $expectedSmapiPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Native-local launch identity mismatch: SMAPI did not remain in the requested GamePath."
    }
    $matches = [regex]::Matches(
        $(if ([string]::IsNullOrWhiteSpace($actual.CommandLine)) { "" } else { $actual.CommandLine }),
        '(?i)(?:^|\s)--mods-path\s+(?:"(?<double>[^"]+)"|''(?<single>[^'']+)''|(?<bare>[^\s]+))')
    if ($matches.Count -ne 1) { throw "Native-local launch identity mismatch: expected exactly one --mods-path." }
    $match = $matches[0]
    $actualModsPath = if ($match.Groups['double'].Success) { $match.Groups['double'].Value } elseif ($match.Groups['single'].Success) { $match.Groups['single'].Value } else { $match.Groups['bare'].Value }
    if ([string]::IsNullOrWhiteSpace($actualModsPath) -or -not [string]::Equals((Get-NormalizedWindowsPath $actualModsPath), $expectedModsPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Native-local launch identity mismatch: SMAPI did not retain the requested ModsPath."
    }
}

Assert-NoStardewProcesses 'fixture preparation'
$prepared = $false
$workingSavePrepared = $false
$process = $null
try {
    $bindingPath = Get-ChildItem -LiteralPath $FixtureRoot -Filter '*.native-local-binding.json' -File | Where-Object {
        try { (Get-Content -Raw -LiteralPath $_.FullName | ConvertFrom-Json).observedSaveSlot -eq $SaveName } catch { $false }
    } | Select-Object -First 1 -ExpandProperty FullName
    if ([string]::IsNullOrWhiteSpace($bindingPath)) {
        $logicalSaveName = $SaveName -replace '_[0-9]{1,32}$', ''
        throw "Navigation read-only gate requires bootstrap-captured binding '$logicalSaveName.native-local-binding.json' for observed slot $SaveName. Bootstrap with an existing action fixture first, then rerun this gate."
    }
    node (Join-Path $PSScriptRoot "prepare-stardew-native-local-player-fixture.mjs") --root $FixtureRoot --mods-path $ModsPath --release-dir $releaseDir --save-name $SaveName --backup-name $backupName --timeout-seconds $TimeoutSeconds --action navigation_read_only --binding-path $bindingPath
    if ($LASTEXITCODE -ne 0) { throw "Native-local Navigation fixture prepare failed." }
    $prepared = $true
    & $fixtureSaveHarness -FixtureRoot $FixtureRoot -TemplateName $SaveName -SaveName $SaveName -StardewSaveRoot $stardewSaveRoot
    if ($LASTEXITCODE -ne 0) { throw "Native-local Navigation working-save restore failed." }
    $workingSavePrepared = $true

    $process = Start-Process -FilePath $smapi -ArgumentList @("--mods-path", ('"{0}"' -f $ModsPath)) -WorkingDirectory $GamePath -PassThru
    $pipeName = (Get-Content -Raw -LiteralPath $clientConfig | ConvertFrom-Json).PipeName
    if ([string]::IsNullOrWhiteSpace($pipeName)) { throw "Native-local fixture config has no pipe name." }
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while (-not (Test-GameBuddyNamedPipeListening -PipeName $pipeName)) {
        Start-Sleep -Milliseconds 250
        if ($process.HasExited) { throw "Native-local SMAPI process exited before Navigation read-only smoke." }
        if ([DateTime]::UtcNow -ge $deadline) { throw "Native-local bridge pipe was not ready before timeout." }
    }
    Start-Sleep -Milliseconds 300
    Assert-LaunchedSmapiIdentity -ExpectedSmapi $smapi -ExpectedModsPath $ModsPath
    node $gateScript --client-config $clientConfig
    if ($LASTEXITCODE -ne 0) { throw "Native-local Navigation read-only direct gate did not pass." }
} finally {
    $teardownFailure = $null
    try {
        if ($null -ne $process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force; $process.WaitForExit() }
        Assert-NoStardewProcesses 'fixture teardown'
    } catch { $teardownFailure = $_ }
    if ($prepared) {
        node (Join-Path $PSScriptRoot "restore-stardew-native-local-player-fixture.mjs") --root $FixtureRoot --mods-path $ModsPath --release-dir $releaseDir --backup-name $backupName
        if ($LASTEXITCODE -ne 0) { throw "Native-local Navigation fixture restore failed; transaction remains fail-closed." }
    }
    if ($workingSavePrepared) {
        & $fixtureSaveHarness -FixtureRoot $FixtureRoot -TemplateName $SaveName -SaveName $SaveName -StardewSaveRoot $stardewSaveRoot -Cleanup
        if ($LASTEXITCODE -ne 0) { throw "Native-local Navigation working-save cleanup failed; save recovery requires operator attention." }
    }
    if ($null -ne $teardownFailure) { throw $teardownFailure }
}
