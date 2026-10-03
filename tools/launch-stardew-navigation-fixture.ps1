# Launch the native-local navigation fixture against a real SMAPI install.
#
# Parameterized replacement for tools/launch-stardew-navigation-fixture.cmd:
# every machine-specific path is a parameter or environment variable, never a
# hard-coded absolute path. Defaults mirror the original .cmd so existing
# invocations keep working; override any of them per machine.
#
#   -RepositoryRoot  path to the ai-game-companion checkout (default: this repo)
#   -ReleaseDir      built mod output (default: <root>/integrations/stardew/bin/Release/net6.0)
#   -GameDir         Stardew Valley install root (required; default from GAMEBUDDY_STARDEW_GAME_DIR)
#   -FixtureRoot     fixture staging root (default: %LOCALAPPDATA%\GameBuddy\stardew-fixtures)
#   -SaveName        fixture save name (default: GameBuddyFixtureNavigation_447088730)
[CmdletBinding()]
param(
    [string]$RepositoryRoot,
    [string]$ReleaseDir,
    [string]$GameDir = $env:GAMEBUDDY_STARDEW_GAME_DIR,
    [string]$FixtureRoot = (Join-Path $env:LOCALAPPDATA "GameBuddy\stardew-fixtures"),
    [string]$SaveName = "GameBuddyFixtureNavigation_447088730"
)

$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    $RepositoryRoot = Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\..")
}
if ([string]::IsNullOrWhiteSpace($ReleaseDir)) {
    $ReleaseDir = Join-Path $RepositoryRoot "integrations\stardew\bin\Release\net6.0"
}
if ([string]::IsNullOrWhiteSpace($GameDir)) {
    throw "GameDir is required: pass -GameDir or set GAMEBUDDY_STARDEW_GAME_DIR"
}

$ModsPath = Join-Path $env:LOCALAPPDATA "GameBuddy\stardew-profiles\native-local-navigation"
$BindingPath = Join-Path $FixtureRoot "$SaveName.native-local-binding.json"

Write-Host "Stopping any running SMAPI..."
Get-Process -Name "StardewModdingAPI" -ErrorAction SilentlyContinue | Stop-Process -Force

if (Test-Path "$FixtureRoot\native-local-navigation-fixture-backup") {
    Remove-Item -Recurse -Force "$FixtureRoot\native-local-navigation-fixture-backup"
}
if (Test-Path "$FixtureRoot\.stardew-native-local-player-fixture.lock") {
    Remove-Item -Recurse -Force "$FixtureRoot\.stardew-native-local-player-fixture.lock"
}

Write-Host "Preparing fixture (step 1: restore + prepare)..."
& node tools/prepare-stardew-native-local-player-fixture.mjs --root $FixtureRoot --mods-path $ModsPath --release-dir $ReleaseDir --save-name $SaveName --backup-name "native-local-navigation-fixture-backup" --timeout-seconds 120 --action navigation_mutation --binding-path $BindingPath --stardew-save-root "$env:APPDATA\StardewValley\Saves"
& powershell.exe -NoProfile -File tools/prepare-stardew-action-fixture.ps1 -FixtureRoot $FixtureRoot -TemplateName $SaveName -SaveName $SaveName -StardewSaveRoot "$env:APPDATA\StardewValley\Saves"

Write-Host "Clearing stale Body Program journal after backup..."
$binding = Get-Content -Raw $BindingPath | ConvertFrom-Json
$scope = Join-Path (Join-Path $env:APPDATA "StardewValley\Saves") ("BodyProgramJournal-v1\stardew\{0}\{1}\{2}\{3}" -f $binding.saveId, $binding.worldId, $binding.playerId, $binding.companionId)
if (Test-Path -LiteralPath $scope) { Remove-Item -LiteralPath $scope -Recurse -Force }

Write-Host "Launching StardewModdingAPI.exe from $GameDir ..."
Start-Process -FilePath (Join-Path $GameDir "StardewModdingAPI.exe") -ArgumentList @("--mods-path", ('"{0}"' -f $ModsPath)) -WorkingDirectory $GameDir -WindowStyle Normal