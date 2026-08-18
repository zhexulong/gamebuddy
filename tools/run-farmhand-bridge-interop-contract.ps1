[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$gamePath = $env:GAMEBUDDY_STARDEW_GAME_PATH
if ([string]::IsNullOrWhiteSpace($gamePath) -or -not (Test-Path -LiteralPath (Join-Path $gamePath 'Stardew Valley.dll'))) {
    throw 'Set GAMEBUDDY_STARDEW_GAME_PATH to the target Stardew installation before running the Farmhand bridge interop contract.'
}

function Invoke-Checked {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    & $Arguments[0] $Arguments[1..($Arguments.Length - 1)]
    if ($LASTEXITCODE -ne 0) {
        throw "$($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

$interopProject = Join-Path $repositoryRoot 'integrations\stardew\tests\FarmhandBridgeInterop.Contract.csproj'
$hostRoot = Join-Path $repositoryRoot 'host'
$interopTest = Join-Path $hostRoot 'dist-test\farmhand-bridge-interop.test.js'

Invoke-Checked dotnet build $interopProject --configuration Release --no-restore "-p:GamePath=$gamePath"
Push-Location $hostRoot
try {
    Invoke-Checked .\node_modules\.bin\tsc.cmd --project tsconfig.test.json
    Invoke-Checked node --test --test-timeout=100000 $interopTest
}
finally {
    Pop-Location
}
