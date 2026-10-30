param(
    [Parameter(Mandatory = $true)][string]$SetupPath,
    [Parameter(Mandatory = $true)][string]$WorkRoot
)

$ErrorActionPreference = 'Stop'

# =============================================================================
# The install/uninstall round trip, driven against a scratch LocalApplicationData.
#
# This is the host-side twin of tools/sandbox/sandbox-verify.cmd: it exercises the same
# product operations on this machine, so a regression in the installer shape is caught
# without needing a sandbox run. The sandbox run is still the authority on "no developer
# tooling present"; this is the authority on "the round trip actually completes".
#
# Both operations are given the SAME --local-application-data. That is not incidental: an
# uninstall launched without it resolves the layout from the real %LOCALAPPDATA%, so it
# reports installer_ok while leaving the scratch program root untouched - an observation
# that looks exactly like a product defect and is in fact a caller mistake.
# =============================================================================

function Fail([string]$Reason) {
    Write-Output "sandbox_check_failed:$Reason"
    exit 1
}

Remove-Item -Recurse -Force $WorkRoot -ErrorAction SilentlyContinue
$localAppData = Join-Path $WorkRoot 'AppData\Local'
New-Item -ItemType Directory -Force -Path $localAppData | Out-Null

if (-not (Test-Path $SetupPath)) { Fail 'setup_absent' }

# ----------------------------------------------------------------- install
$installOutput = & $SetupPath --local-application-data $localAppData --version 1.2.3 2>&1
if ($LASTEXITCODE -ne 0) { Fail "install_exit_$LASTEXITCODE" }
if ($installOutput -notcontains 'installer_ok') { Fail 'install_not_ok' }
Write-Output 'check:install_exit_ok'

$programRoot = Join-Path $localAppData 'Programs\GameBuddy'
if (-not (Test-Path $programRoot)) { Fail 'program_root_absent' }
if (-not (Test-Path (Join-Path $programRoot 'GameBuddy.Desktop.exe'))) { Fail 'launcher_absent' }
if (-not (Test-Path (Join-Path $programRoot 'current.json'))) { Fail 'pointer_absent' }
if (-not (Test-Path (Join-Path $programRoot 'uninstall\GameBuddy.Setup.exe'))) { Fail 'uninstaller_absent' }
Write-Output 'check:program_root_layout'

$pointer = Get-Content -Raw (Join-Path $programRoot 'current.json') | ConvertFrom-Json
$generationRoot = Join-Path $programRoot "generations\$($pointer.generation)"
foreach ($relative in @(
    'runtime\node.exe',
    'main.js',
    'native\smapi\win-x64\StardewModdingAPI.exe',
    'native\smapi\payload-manifest.json',
    'native\smapi\SMAPI-LICENSE.txt'
)) {
    if (-not (Test-Path (Join-Path $generationRoot $relative))) { Fail "generation_absent_$relative" }
}
Write-Output 'check:generation_payload'

$licence = Get-Content -Raw (Join-Path $generationRoot 'native\smapi\SMAPI-LICENSE.txt')
if ($licence -notmatch 'GNU LESSER GENERAL PUBLIC LICENSE') { Fail 'smapi_licence_text_absent' }
Write-Output 'check:smapi_licence'

# --------------------------------------------------------------- uninstall
$uninstaller = Join-Path $programRoot 'uninstall\GameBuddy.Setup.exe'
$uninstallOutput = & $uninstaller --uninstall --local-application-data $localAppData 2>&1
if ($LASTEXITCODE -ne 0) { Fail "uninstall_exit_$LASTEXITCODE" }
if ($uninstallOutput -notcontains 'installer_ok') { Fail 'uninstall_not_ok' }

# The uninstaller runs from inside the program root, so it schedules the removal and exits.
# Its own account has to say which strategy ran: the two used to print the same code whether
# or not the removal ever happened.
if ($uninstallOutput -notcontains 'uninstall_strategy:scheduled') { Fail 'uninstall_strategy_not_scheduled' }
Write-Output 'check:uninstall_strategy'

$marker = Join-Path $localAppData 'GameBuddy\uninstall-removal-complete.txt'
for ($attempt = 0; $attempt -lt 30; $attempt++) {
    Start-Sleep -Milliseconds 500
    if ((Test-Path $marker) -and -not (Test-Path $programRoot)) { break }
}
if (Test-Path $programRoot) { Fail 'program_root_survived_uninstall' }
if (-not (Test-Path $marker)) { Fail 'removal_marker_absent' }
Write-Output 'check:program_root_removed'

Remove-Item -Recurse -Force $WorkRoot -ErrorAction SilentlyContinue
Write-Output 'sandbox_check_ok'
exit 0
