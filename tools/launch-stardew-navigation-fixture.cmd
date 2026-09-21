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

node tools/prepare-stardew-native-local-player-fixture.mjs --root "%FX%" --mods-path "%MODS%" --release-dir "%RELEASE%" --save-name "%SAVE%" --backup-name "native-local-navigation-fixture-backup" --timeout-seconds 120 --action navigation_mutation --binding-path "%BINDING%"
powershell -NoProfile -File tools/prepare-stardew-action-fixture.ps1 -FixtureRoot "%FX%" -TemplateName "%SAVE%" -SaveName "%SAVE%" -StardewSaveRoot "%APPDATA%\StardewValley\Saves"

powershell -NoProfile -Command "Start-Process -FilePath 'D:\Steam\steamapps\common\Stardew Valley\StardewModdingAPI.exe' -ArgumentList @('--mods-path', ('\"{0}\"' -f '%MODS%')) -WorkingDirectory 'D:\Steam\steamapps\common\Stardew Valley' -WindowStyle Normal"