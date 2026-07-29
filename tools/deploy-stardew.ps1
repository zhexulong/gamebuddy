[CmdletBinding()]
param(
    [string]$GamePath = $env:GAMEBUDDY_STARDEW_GAME_PATH,
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Debug"
)

if ([string]::IsNullOrWhiteSpace($GamePath)) {
    throw "Set GAMEBUDDY_STARDEW_GAME_PATH or pass -GamePath to a Stardew Valley + SMAPI installation."
}

$projectRoot = Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")
& (Join-Path $PSScriptRoot "build-stardew.ps1") -GamePath $GamePath -Configuration $Configuration
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$source = Join-Path $projectRoot "integrations/stardew/bin/$Configuration/net6.0"
$destination = Join-Path $GamePath "Mods/GameBuddy"
$manifest = Join-Path $source "manifest.json"
if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) {
    throw "Build output did not include manifest.json: $manifest"
}

New-Item -ItemType Directory -Force -Path $destination | Out-Null
Get-ChildItem -LiteralPath $destination -Force | Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $source "*") -Destination $destination -Recurse -Force

Write-Host "Deployed the client-local GameBuddy embodiment fixture to $destination"
