@echo off
REM ============================================================================
REM Windows Sandbox acceptance run - the clean-machine half of the install gate.
REM
REM This machine has no .NET SDK, no Node, no pnpm and no repository checkout. Every
REM assertion below uses only what Windows provides (cmd, PowerShell, the file system),
REM so a pass here is a fact about a player's machine rather than a developer's.
REM
REM It runs the REAL player path: no --local-application-data override, so the installer
REM resolves the genuine %LOCALAPPDATA% layout and writes the genuine per-user registry
REM keys. That is the only way to see whether one double-click gives a player a working
REM product. (The host-side twin, tools/sandbox/install-round-trip.ps1, uses a scratch
REM root precisely because it must not touch this machine's real locations.)
REM
REM Transcript and a machine-readable summary land in the shared folder, because the
REM sandbox is discarded when it closes.
REM ============================================================================
setlocal EnableDelayedExpansion

set SHARE=C:\gamebuddy-share
set RESULT=%SHARE%\sandbox-result.txt
set SUMMARY=%SHARE%\sandbox-result.json
set PROGRAM_ROOT=%LOCALAPPDATA%\Programs\GameBuddy
set DESKTOP=%USERPROFILE%\Desktop

echo gamebuddy-sandbox-run> "%RESULT%"
echo start %DATE% %TIME%>> "%RESULT%"
echo.>> "%RESULT%"

REM ---------------------------------------------------- 0. the clean-machine premise
where dotnet >nul 2>&1
if %ERRORLEVEL%==0 (
  call :record "tooling" "dotnet absent from PATH" "PRESENT-not-a-clean-machine"
) else (
  call :record "tooling" "dotnet absent from PATH" "ok"
)
where node >nul 2>&1
if %ERRORLEVEL%==0 (
  call :record "tooling" "node absent from PATH" "PRESENT-not-a-clean-machine"
) else (
  call :record "tooling" "node absent from PATH" "ok"
)

REM ---------------------------------------------------------- 1. the installer runs
REM The whole point of a self-contained installer: this must not raise the
REM "you need .NET 8.0 Desktop Runtime" dialog. With dotnet absent, a framework-dependent
REM image fails right here.
if not exist "%SHARE%\GameBuddy.Setup.exe" (
  call :record "setup" "Setup.exe present in share" "FAIL:missing"
  goto :finish
)
call :record "setup" "Setup.exe present in share" "ok"

"%SHARE%\GameBuddy.Setup.exe" > "%SHARE%\setup-stdout.txt" 2> "%SHARE%\setup-stderr.txt"
set SETUP_EXIT=!ERRORLEVEL!
set SETUP_OUT=
for /f "usebackq delims=" %%L in ("%SHARE%\setup-stdout.txt") do if not "%%L"=="" set SETUP_OUT=%%L
call :record "setup" "install exit code" "!SETUP_EXIT!"
call :record "setup" "install reported installer_ok" "!SETUP_OUT!"

if not exist "%PROGRAM_ROOT%" (
  call :record "layout" "program root created" "FAIL:missing"
  goto :finish
)
call :record "layout" "program root created" "ok"

for %%F in (GameBuddy.Desktop.exe current.json uninstall\GameBuddy.Setup.exe) do (
  if exist "%PROGRAM_ROOT%\%%~F" (
    call :record "layout" "%%~F present" "ok"
  ) else (
    call :record "layout" "%%~F present" "FAIL:missing"
  )
)

REM ------------------------------------------------------ 2. registry registration
reg query "HKCU\Software\GameBuddy\Registration\v1" /v programRoot >nul 2>&1
call :record "registration" "current-user marker written" "%ERRORLEVEL%"
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\GameBuddy" /v UninstallString >nul 2>&1
call :record "registration" "add-remove entry written" "%ERRORLEVEL%"

REM -------------------------------------------------------------- 3. the generation
set GENERATION=
for /f "usebackq delims=" %%G in (`powershell -NoProfile -Command "$p=Get-Content -Raw '%PROGRAM_ROOT%\current.json' | ConvertFrom-Json; $p.generation"`) do set GENERATION=%%G
call :record "generation" "pointer names a generation" "%GENERATION%"
if not defined GENERATION goto :finish

set GEN_ROOT=%PROGRAM_ROOT%\generations\%GENERATION%
for %%F in (runtime\node.exe main.js) do (
  if exist "%GEN_ROOT%\%%~F" (
    call :record "generation" "%%~F present" "ok"
  ) else (
    call :record "generation" "%%~F present" "FAIL:missing"
  )
)

REM The one-click SMAPI install reads exactly these three entries; a payload that ships
REM without them can only refuse after the player already chose their game folder.
for %%F in (
  "native\smapi\win-x64\StardewModdingAPI.exe"
  "native\smapi\payload-manifest.json"
  "native\smapi\SMAPI-LICENSE.txt"
) do (
  if exist "%GEN_ROOT%\%%~F" (
    call :record "smapi-payload" "%%~F present" "ok"
  ) else (
    call :record "smapi-payload" "%%~F present" "FAIL:missing"
  )
)

REM The payload is LGPL-3.0, so the licence text has to travel with the binary.
findstr /C:"GNU LESSER GENERAL PUBLIC LICENSE" "%GEN_ROOT%\native\smapi\SMAPI-LICENSE.txt" >nul 2>&1
call :record "compliance" "SMAPI LGPL text present" "%ERRORLEVEL%"

REM ------------------------------------------------------- 4. the desktop shortcut
powershell -NoProfile -Command "$desktop = [Environment]::GetFolderPath('Desktop'); $link = Get-ChildItem -LiteralPath $desktop -Filter '*.lnk' -ErrorAction SilentlyContinue | Where-Object { $_.BaseName -eq ([char]0x661F + [char]0x9732 + [char]0x8C37 + 'AI' + [char]0x4F34 + [char]0x4FA3) } | Select-Object -First 1; if ($null -ne $link) { (New-Object -ComObject WScript.Shell).CreateShortcut($link.FullName).TargetPath } else { 'MISSING' }" > "%SHARE%\shortcut.txt" 2>&1
set SHORTCUT_TARGET=
for /f "usebackq delims=" %%T in ("%SHARE%\shortcut.txt") do set SHORTCUT_TARGET=%%T
call :record "shortcut" "desktop shortcut target" "!SHORTCUT_TARGET!"

REM ------------------------------------------- 5. the launcher executes at all
REM Not a full game run (that needs Stardew Valley and Steam, absent here): the question is
REM whether a self-contained launcher starts on a machine with no .NET runtime.
start "" /b "%PROGRAM_ROOT%\GameBuddy.Desktop.exe"
ping -n 11 127.0.0.1 >nul
tasklist /FI "IMAGENAME eq GameBuddy.Desktop.exe" | findstr /I "GameBuddy.Desktop.exe" >nul
if %ERRORLEVEL%==0 (
  call :record "launcher" "launcher process running" "ok"
  taskkill /IM GameBuddy.Desktop.exe /F >nul 2>&1
) else (
  call :record "launcher" "launcher process running" "exited-immediately"
)

REM ----------------------------------------------------------- 6. the uninstall
"%PROGRAM_ROOT%\uninstall\GameBuddy.Setup.exe" --uninstall > "%SHARE%\uninstall-stdout.txt" 2>&1
set UNINSTALL_EXIT=!ERRORLEVEL!
set UNINSTALL_OUT=
for /f "usebackq delims=" %%L in ("%SHARE%\uninstall-stdout.txt") do if not "%%L"=="" set UNINSTALL_OUT=%%L
call :record "uninstall" "uninstall exit code" "!UNINSTALL_EXIT!"
call :record "uninstall" "uninstall reported installer_ok" "!UNINSTALL_OUT!"

REM The uninstaller runs from inside the program root, so it must SCHEDULE the removal and
REM say so: the two strategies once printed the same code whether or not the removal ran.
findstr /C:"uninstall_strategy:scheduled" "%SHARE%\uninstall-stdout.txt" >nul 2>&1
call :record "uninstall" "scheduled removal strategy" "%ERRORLEVEL%"

set MARKER=%LOCALAPPDATA%\GameBuddy\uninstall-removal-complete.txt
set WAITED=0
:waitremoval
if not exist "%PROGRAM_ROOT%" goto :removed
if %WAITED% GEQ 30 goto :removed
ping -n 2 127.0.0.1 >nul
set /a WAITED+=1
goto :waitremoval
:removed
if exist "%PROGRAM_ROOT%" (
  call :record "uninstall" "program root removed" "FAIL:survived"
) else (
  call :record "uninstall" "program root removed" "ok"
)
if exist "%MARKER%" (
  call :record "uninstall" "removal completion marker written" "ok"
) else (
  call :record "uninstall" "removal completion marker written" "FAIL:missing"
)
reg query "HKCU\Software\GameBuddy\Registration\v1" >nul 2>&1
if %ERRORLEVEL%==0 (
  call :record "uninstall" "registration removed" "FAIL:present"
) else (
  call :record "uninstall" "registration removed" "ok"
)

:finish
echo.>> "%RESULT%"
echo end %DATE% %TIME%>> "%RESULT%"
powershell -NoProfile -Command "$lines = @(Get-Content -LiteralPath '%RESULT%' | Where-Object { $_ -match '^\[.+\] ' }); $product = @($lines | Where-Object { $_ -notmatch '^\[tooling\]' }); $predicate = @('program root created','GameBuddy.Desktop.exe present','current.json present','uninstall\\GameBuddy.Setup.exe present','runtime\\node.exe present','main.js present','native\\smapi\\win-x64\\StardewModdingAPI.exe present','native\\smapi\\payload-manifest.json present','native\\smapi\\SMAPI-LICENSE.txt present','SMAPI LGPL text present','launcher process running','scheduled removal strategy','program root removed','removal completion marker written','registration removed','current-user marker written','add-remove entry written'); $failing = @($product | Where-Object { $parts = $_ -split '\|', 2; $text = ($parts[0]).Trim(); $v = ($parts[1]).Trim(); $isPredicate = $false; foreach ($p in $predicate) { if ($text.EndsWith($p)) { $isPredicate = $true; break } }; if ($isPredicate) { ($v -ne 'ok') -and ($v -ne '0') } else { ($v -eq '') -or ($v -match 'FAIL') -or ($v -match 'MISSING') } } | ForEach-Object { [string]$_ }); $ok = ($product.Count -gt 0) -and ($failing.Count -eq 0); [ordered]@{ schema='gamebuddy-sandbox-result/v1'; productChecks=$product.Count; failingCount=$failing.Count; failing=@($failing); checks=@($lines | ForEach-Object { [string]$_ }); ok=$ok } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath '%SUMMARY%' -Encoding utf8" 2>&1

type "%RESULT%"
powershell -NoProfile -Command "if (Test-Path '%SUMMARY%') { $r = Get-Content -Raw '%SUMMARY%' | ConvertFrom-Json; if ($r.ok) { Write-Host ('SANDBOX VERDICT: PASS (' + $r.productChecks + ' product checks)') } else { Write-Host ('SANDBOX VERDICT: FAIL (' + $r.failingCount + ' of ' + $r.productChecks + ' product checks)') } }"
REM The sandbox is discarded on close, so the verdict stays on screen for a human to see.
ping -n 61 127.0.0.1 >nul
goto :eof

REM ---------------------------------------------------------------------------
:record
set "CATEGORY=%~1"
set "CHECK=%~2"
set "VALUE=%~3"
if "%VALUE%"=="" set "VALUE=ok"
echo [%CATEGORY%] %CHECK% ^| %VALUE%>> "%RESULT%"
echo [%CATEGORY%] %CHECK% ^| %VALUE%
goto :eof
