[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string]$Configuration = 'Debug'
)

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$gamePath = $env:GAMEBUDDY_STARDEW_GAME_PATH
$contractProjectPath = Join-Path $PSScriptRoot 'FarmhandHandlerSplit.Contract.csproj'
$productionAssemblyPath = Join-Path $repositoryRoot "integrations\stardew\bin\$Configuration\net6.0\GameBuddy.Stardew.dll"
$contractAssemblyPath = Join-Path $PSScriptRoot "bin\$Configuration\net6.0\FarmhandHandlerSplit.Contract.dll"
$sourceRoot = Join-Path $repositoryRoot 'integrations\stardew'

function Invoke-Dotnet {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    & dotnet @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "dotnet $($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

# Building the contract project also compiles the referenced Mod, so the
# inspected DLL is always the artifact of the same build invocation.
if (-not [string]::IsNullOrWhiteSpace($gamePath)) {
    Invoke-Dotnet build $contractProjectPath --configuration $Configuration "-p:GamePath=$gamePath"
}
else {
    Invoke-Dotnet build $contractProjectPath --configuration $Configuration
}

if (-not (Test-Path -LiteralPath $productionAssemblyPath)) {
    throw "Contract build did not produce the required production assembly: $productionAssemblyPath"
}
if (-not (Test-Path -LiteralPath $contractAssemblyPath)) {
    throw "Contract build did not produce the required contract entrypoint: $contractAssemblyPath"
}

$sha256 = [System.Security.Cryptography.SHA256]::Create()
try {
    $expectedSha256 = -join ($sha256.ComputeHash([System.IO.File]::ReadAllBytes($productionAssemblyPath)) | ForEach-Object { $_.ToString('x2') })
}
finally {
    $sha256.Dispose()
}

Invoke-Dotnet $contractAssemblyPath --expected-sha256 $expectedSha256 $productionAssemblyPath --source-root $sourceRoot
