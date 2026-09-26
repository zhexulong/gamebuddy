@echo off
rem Single clean launch of the native-local navigation fixture:
rem stop SMAPI -> clear stale prepare artifacts -> prepare fixture (clears
rem NavigationMutationTargetLabel residue) -> restore working save -> launch -> wait pipe.
setlocal
set "FX=%LOCALAPPDATA%\GameBuddy\stardew-fixtures"
set "MODS=%LOCALAPPDATA%\GameBuddy\stardew-profiles\native-local-navigation"
set "RELEASE=E:\projects\ai-game-companion\integrations\stardew\bin\Release\net6.0"
set "SAVE=GameBuddyFixtureNavigation_447088730"
set "BINDING=%FX%\GameBuddyFixtureNavigation.native-local-binding.json"

powershell -NoProfile -Command "Get-Process -Name 'StardewModdingAPI' -ErrorAction SilentlyContinue | Stop-Process -Force"
if exist "%FX%\native-local-navigation-fixture-backup" rmdir /s /q "%FX%\native-local-navigation-fixture-backup"
if exist "%FX%\.stardew-native-local-player-fixture.lock" rmdir /s /q "%FX%\.stardew-native-local-player-fixture.lock"

node tools/prepare-stardew-native-local-player-fixture.mjs --root "%FX%" --mods-path "%MODS%" --release-dir "%RELEASE%" --save-name "%SAVE%" --backup-name "native-local-navigation-fixture-backup" --timeout-seconds 120 --action navigation_mutation --binding-path "%BINDING%" --stardew-save-root "%APPDATA%\StardewValley\Saves"
rem Restore first: it puts back both the Mod files and the scope-bound Body
rem Program journal, so the next launch starts from the state this script chose
rem rather than from whatever the previous run left in the journal.
powershell -NoProfile -File tools/prepare-stardew-action-fixture.ps1 -FixtureRoot "%FX%" -TemplateName "%SAVE%" -SaveName "%SAVE%" -StardewSaveRoot "%APPDATA%\StardewValley\Saves"
rem Clear the scope-bound Body Program journal AFTER prepare has backed it up.
rem This script uses the clear-stale pattern instead of a paired restore, so
rem without this the run would inherit the previous run's program state: a
rem leftover RecoveryRequired journal makes the Mod decline to compose the
rem controller, and submit_action_program then fails closed
rem (body_program_journal_unavailable) for no reason the prompt or world shows.
powershell -NoProfile -Command "$binding = Get-Content -Raw '%BINDING%' | ConvertFrom-Json; $scope = Join-Path (Join-Path $env:APPDATA 'StardewValley\Saves') ('BodyProgramJournal-v1\stardew\{0}\{1}\{2}\{3}' -f $binding.saveId, $binding.worldId, $binding.playerId, $binding.companionId); if (Test-Path -LiteralPath $scope) { Remove-Item -LiteralPath $scope -Recurse -Force }"

powershell -NoProfile -Command "Start-Process -FilePath 'D:\Steam\steamapps\common\Stardew Valley\StardewModdingAPI.exe' -ArgumentList @('--mods-path', ('\"{0}\"' -f '%MODS%')) -WorkingDirectory 'D:\Steam\steamapps\common\Stardew Valley' -WindowStyle Normal"