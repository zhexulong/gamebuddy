[CmdletBinding()]
param(
    [string]$GamePath = $env:GAMEBUDDY_STARDEW_GAME_PATH,
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Debug"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")).Path
$tempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("gamebuddy-stardew-action-projection-" + [guid]::NewGuid().ToString("N"))

try {
    # This verifier consumes only the restrictive Farmhand registry projection.
    # Do not build unrelated Host WIP (for example, P5 continuity sources) merely
    # to obtain this one module.
    $hostSourceRoot = Join-Path $projectRoot "host"
    $hostProjectionOutput = Join-Path $hostSourceRoot "dist-action-projection"
    Remove-Item -LiteralPath $hostProjectionOutput -Recurse -Force -ErrorAction SilentlyContinue
    Push-Location $hostSourceRoot
    try {
        & pnpm exec tsc --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck --outDir dist-action-projection --rootDir src --noEmitOnError src/action-class.ts src/action-registry.ts
        if ($LASTEXITCODE -ne 0) { throw "Farmhand Host registry projection compile failed with exit code $LASTEXITCODE." }
    }
    finally {
        Pop-Location
    }

    # This verifier proves the ordinary Farmhand projection only. Building the
    # topology-isolated Portfolio contracts here would make unrelated Portfolio
    # work a false prerequisite for the Farmhand SSOT gate.
    & dotnet build (Join-Path $projectRoot "integrations/stardew/GameBuddy.Stardew.csproj") --configuration $Configuration "-p:GamePath=$GamePath"
    if ($LASTEXITCODE -ne 0) { throw "Farmhand Mod build failed with exit code $LASTEXITCODE." }

    & dotnet build (Join-Path $projectRoot "integrations/stardew/tests/FarmhandActionCapabilityProjection.Contract.csproj") --configuration $Configuration --no-restore "-p:GamePath=$GamePath"
    if ($LASTEXITCODE -ne 0) { throw "Projection contract build failed with exit code $LASTEXITCODE." }

    $modAssembly = Join-Path $projectRoot "integrations/stardew/bin/$Configuration/net6.0/GameBuddy.Stardew.dll"
    $projectionContract = Join-Path $projectRoot "integrations/stardew/tests/bin/$Configuration/net6.0/FarmhandActionCapabilityProjection.Contract.exe"
    $hostRegistry = Join-Path $hostProjectionOutput "action-registry.js"
    $manifestPath = Join-Path $tempDirectory "farmhand-action-projection.json"
    foreach ($path in @($modAssembly, $projectionContract, $hostRegistry)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Expected verification artifact was not produced: $path" }
    }

    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
        $expectedSha256 = -join ($sha256.ComputeHash([System.IO.File]::ReadAllBytes($modAssembly)) | ForEach-Object { $_.ToString("x2") })
    }
    finally {
        $sha256.Dispose()
    }

    New-Item -ItemType Directory -Path $tempDirectory -ErrorAction Stop | Out-Null
    & $projectionContract --write-default-enabled-actions $expectedSha256 $modAssembly $manifestPath
    if ($LASTEXITCODE -ne 0) { throw "Projection manifest generation failed with exit code $LASTEXITCODE." }
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "Projection contract did not produce the expected temporary manifest: $manifestPath" }
    & node (Join-Path $projectRoot "tools/verify-stardew-action-projection.mjs") $manifestPath $hostRegistry
    if ($LASTEXITCODE -ne 0) { throw "Action projection verifier failed with exit code $LASTEXITCODE." }
}
finally {
    Remove-Item -LiteralPath $tempDirectory -Recurse -Force -ErrorAction SilentlyContinue
}
