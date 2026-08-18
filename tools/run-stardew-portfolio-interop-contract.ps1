[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$gamePath = $env:GAMEBUDDY_STARDEW_GAME_PATH
$expectedGameVersion = '1.6.15.24356'
$expectedGameSha256 = '7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee'
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
    throw 'Portfolio bridge interop attestation requires the Windows named-pipe implementation.'
}
if ([string]::IsNullOrWhiteSpace($gamePath) -or -not (Test-Path -LiteralPath (Join-Path $gamePath 'Stardew Valley.dll'))) {
    throw 'Set GAMEBUDDY_STARDEW_GAME_PATH to the target Stardew installation before running the Portfolio bridge interop contract.'
}
function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha256.Dispose()
        $stream.Dispose()
    }
}

$gameAssemblyPath = Join-Path $gamePath 'Stardew Valley.dll'
$gameVersion = (Get-Item -LiteralPath $gameAssemblyPath).VersionInfo.FileVersion
$gameSha256 = Get-Sha256 $gameAssemblyPath
if ($gameVersion -ne $expectedGameVersion -or $gameSha256 -ne $expectedGameSha256) {
    throw "Portfolio bridge interop attestation requires Stardew Valley.dll $expectedGameVersion with its pinned SHA-256."
}

function Invoke-Checked {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    & $Arguments[0] $Arguments[1..($Arguments.Length - 1)]
    if ($LASTEXITCODE -ne 0) {
        throw "$($Arguments -join ' ') failed with exit code $LASTEXITCODE."
    }
}

$interopProject = Join-Path $repositoryRoot 'integrations\stardew\tests\PortfolioStardewInterop.Contract.csproj'
$hostRoot = Join-Path $repositoryRoot 'host'
$interopTest = Join-Path $hostRoot 'dist-test\portfolio-stardew-interop.test.js'
$peerPath = Join-Path $repositoryRoot 'integrations\stardew\tests\bin\Release\net6.0\PortfolioStardewInterop.Contract.dll'
$productionAssemblyPath = Join-Path $repositoryRoot 'integrations\stardew\bin\Release\net6.0\GameBuddy.Stardew.dll'

Invoke-Checked dotnet build $interopProject --configuration Release --no-restore "-p:GamePath=$gamePath"
if (-not (Test-Path -LiteralPath $peerPath) -or -not (Test-Path -LiteralPath $productionAssemblyPath)) {
    throw 'Portfolio bridge interop build did not produce its canonical peer and production assembly.'
}

# The attested Node path may only launch the peer just built above. The peer
# independently validates the compiled production assembly hash it loads.
# The test file runs BOTH frozen scenarios - the success terminal-drain
# scenario (exact private ModEntry.DrainPortfolioMineElevatorTerminalDeliveries
# -> real pipe -> real PortfolioStardewBridgeClient succeeded receipt +
# second-drain dequeue) and the accepted-then-cancel scenario (exact private
# ModEntry.HandlePortfolioMineElevatorCancel -> compiled session -> compiled
# coordinator -> real pipe -> real client) - each spawning the peer with its
# explicit scenario argument and a fresh pipe name; node --test fails the run
# if either scenario fails.
Remove-Item Env:GAMEBUDDY_PORTFOLIO_INTEROP_PEER_DLL -ErrorAction Ignore
$env:GAMEBUDDY_PORTFOLIO_INTEROP_ATTESTED = '1'
$env:GAMEBUDDY_PORTFOLIO_INTEROP_PEER_SHA256 = Get-Sha256 $peerPath
$env:GAMEBUDDY_PORTFOLIO_INTEROP_PRODUCTION_ASSEMBLY_SHA256 = Get-Sha256 $productionAssemblyPath
Push-Location $hostRoot
try {
    Invoke-Checked .\node_modules\.bin\tsc.cmd --project tsconfig.test.json
    Invoke-Checked node --test --test-timeout=100000 $interopTest
}
finally {
    Remove-Item Env:GAMEBUDDY_PORTFOLIO_INTEROP_ATTESTED -ErrorAction Ignore
    Remove-Item Env:GAMEBUDDY_PORTFOLIO_INTEROP_PEER_SHA256 -ErrorAction Ignore
    Remove-Item Env:GAMEBUDDY_PORTFOLIO_INTEROP_PRODUCTION_ASSEMBLY_SHA256 -ErrorAction Ignore
    Pop-Location
}
