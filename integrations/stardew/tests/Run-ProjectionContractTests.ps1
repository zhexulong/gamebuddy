[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$gamePath = $env:GAMEBUDDY_STARDEW_GAME_PATH
if ([string]::IsNullOrWhiteSpace($gamePath) -or -not (Test-Path -LiteralPath (Join-Path $gamePath 'Stardew Valley.dll'))) {
    throw 'Set GAMEBUDDY_STARDEW_GAME_PATH to the target Stardew installation before running projection contracts.'
}
$solutionPath = Join-Path $repositoryRoot 'GameBuddy.sln'
$productionAssemblyPath = Join-Path $repositoryRoot "integrations\stardew\bin\$Configuration\net6.0\GameBuddy.Stardew.dll"
$portfolioProjectPath = Join-Path $PSScriptRoot 'PortfolioMineElevatorProjection.Contract.csproj'
$farmhandProjectPath = Join-Path $PSScriptRoot 'FarmhandActionCapabilityProjection.Contract.csproj'

function Invoke-Dotnet {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    & dotnet @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

# The solution build is intentionally first: it must compile every checked projection-contract executable.
Invoke-Dotnet build $solutionPath --configuration $Configuration "-p:GamePath=$gamePath"

if (-not (Test-Path -LiteralPath $productionAssemblyPath)) {
    throw "Solution build did not produce the required production assembly: $productionAssemblyPath"
}

# Use each project's compiled entrypoint directly. Project-launch resolution can
# otherwise select a sibling contract launcher from their shared output dir.
$portfolioAssemblyPath = Join-Path $PSScriptRoot "bin\$Configuration\net6.0\PortfolioMineElevatorProjection.Contract.dll"
$farmhandAssemblyPath = Join-Path $PSScriptRoot "bin\$Configuration\net6.0\FarmhandActionCapabilityProjection.Contract.dll"
if (-not (Test-Path -LiteralPath $portfolioAssemblyPath) -or -not (Test-Path -LiteralPath $farmhandAssemblyPath)) {
    throw 'Solution build did not produce both projection-contract entrypoints.'
}
$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $expectedSha256 = -join ($sha256.ComputeHash([System.IO.File]::ReadAllBytes($productionAssemblyPath)) | ForEach-Object { $_.ToString('x2') })
}
finally {
    $sha256.Dispose()
}
Invoke-Dotnet $portfolioAssemblyPath --expected-sha256 $expectedSha256 $productionAssemblyPath
Invoke-Dotnet $farmhandAssemblyPath --expected-sha256 $expectedSha256 $productionAssemblyPath
