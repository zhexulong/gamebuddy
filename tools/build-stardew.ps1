[CmdletBinding()]
param(
    [string]$GamePath = $env:GAMEBUDDY_STARDEW_GAME_PATH,
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Debug"
)

if ([string]::IsNullOrWhiteSpace($GamePath)) {
    throw "Set GAMEBUDDY_STARDEW_GAME_PATH or pass -GamePath to a Stardew Valley + SMAPI installation."
}

$requiredFiles = @(
    "Stardew Valley.dll",
    "StardewModdingAPI.dll",
    "StardewModdingAPI.exe"
)

foreach ($file in $requiredFiles) {
    $path = Join-Path $GamePath $file
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Missing '$file' under '$GamePath'. Install SMAPI into that Stardew Valley directory before building."
    }
}

$projectRoot = Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")
& dotnet build (Join-Path $projectRoot "GameBuddy.sln") --configuration $Configuration "-p:GamePath=$GamePath"
exit $LASTEXITCODE
