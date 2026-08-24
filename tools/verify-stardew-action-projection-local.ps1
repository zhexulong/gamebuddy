[CmdletBinding()]
param(
    [string]$GamePath = $env:GAMEBUDDY_STARDEW_GAME_PATH,
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Debug"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")).Path

if ([string]::IsNullOrWhiteSpace($GamePath)) {
    $GamePath = "D:\Steam\steamapps\common\Stardew Valley"
}

# Build Core and Mod
& dotnet build (Join-Path $projectRoot "integrations/stardew/src/Core/GameBuddy.Stardew.Core.csproj") --configuration $Configuration
if ($LASTEXITCODE -ne 0) { throw "GameBuddy.Stardew.Core build failed with exit code $LASTEXITCODE." }

& dotnet build (Join-Path $projectRoot "integrations/stardew/GameBuddy.Stardew.csproj") --configuration $Configuration "-p:GamePath=$GamePath"
if ($LASTEXITCODE -ne 0) { throw "GameBuddy.Stardew build failed with exit code $LASTEXITCODE." }

# Run Core Tests
& dotnet test (Join-Path $projectRoot "integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/GameBuddy.Stardew.Core.Tests.csproj") --configuration $Configuration
if ($LASTEXITCODE -ne 0) { throw "GameBuddy.Stardew.Core.Tests failed with exit code $LASTEXITCODE." }

# Run Integration Tests
& dotnet test (Join-Path $projectRoot "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/GameBuddy.Stardew.Integration.Tests.csproj") --configuration $Configuration "-p:GamePath=$GamePath"
if ($LASTEXITCODE -ne 0) { throw "GameBuddy.Stardew.Integration.Tests failed with exit code $LASTEXITCODE." }

# Run Action Projection Validation
& pnpm test:stardew-action-projection
if ($LASTEXITCODE -ne 0) { throw "Action projection verifier failed with exit code $LASTEXITCODE." }

Write-Host "Local action projection verification passed."
