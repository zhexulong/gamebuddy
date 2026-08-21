[CmdletBinding()]
param(
    [string]$GamePath = $env:GAMEBUDDY_STARDEW_GAME_PATH,
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Debug"
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")).Path

function Assert-ExternalSuccess([string]$Command) {
    if ($LASTEXITCODE -ne 0) {
        throw "Phase command failed ($LASTEXITCODE): $Command"
    }
}

function Write-Phase([string]$Name) {
    Write-Host "P2C phase: $Name"
}

$P2OwnedPaths = @(
    "integrations/stardew/src/Core/GameBuddy.Stardew.Core.csproj",
    "integrations/stardew/src/Core/Models/BridgeProtocolModels.cs",
    "integrations/stardew/src/Core/Protocol/BridgeProtocol.cs",
    "integrations/stardew/src/Core/Policy/FarmhandActionDefinitions.cs",
    "integrations/stardew/src/Core/Policy/FarmhandCapabilitySurface.cs",
    "integrations/stardew/src/Core/Policy/ActionPolicyEngine.cs",
    "integrations/stardew/src/Core/Abstractions/IFarmhandActionHandler.cs",
    "integrations/stardew/src/Core/Abstractions/IExecutionLedger.cs",
    "integrations/stardew/src/Core/Routing/FarmhandActionRouter.cs",
    "integrations/stardew/ModConfig.cs",
    "integrations/stardew/BridgeSession.cs",
    "integrations/stardew/ExecutionManager.cs",
    "integrations/stardew/Handlers/ActionPreconditionGuard.cs",
    "integrations/stardew/Handlers/FarmingActionHandler.cs",
    "integrations/stardew/Handlers/GatheringActionHandler.cs",
    "integrations/stardew/Handlers/MovementActionHandler.cs",
    "integrations/stardew/Handlers/MachineAndAnimalActionHandler.cs",
    "integrations/stardew/Handlers/ResourceToolActionHandler.cs",
    "integrations/stardew/LocalPipeBridge.cs",
    "integrations/stardew/ModEntry.cs",
    "integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/GameBuddy.Stardew.Core.Tests.csproj",
    "integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/FarmhandActionRouterTests.cs",
    "integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/FarmhandActionRouterPropertyTests.cs",
    "integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ActionPolicyEngineTests.cs",
    "integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/ActionPolicyEnginePropertyTests.cs",
    "integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/BridgeProtocolSerializationTests.cs",
    "integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/BridgeProtocolPropertyTests.cs",
    "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/GameBuddy.Stardew.Integration.Tests.csproj",
    "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/NativeFarmingContractTests.cs",
    "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/NativeToolContractTests.cs",
    "integrations/stardew/tests/FarmhandLocalPipeBridgeDeliveryTests.cs",
    "host/src/action-registry.ts",
    "host/src/game-tools.ts",
    "host/src/protocol.ts",
    "host/src/execution-correlation-ledger.ts",
    "host/src/stardew-integration-module.ts",
    "host/src/action-registry.test.ts",
    "host/src/game-tools.test.ts",
    "host/src/protocol.test.ts",
    "host/src/execution-correlation-ledger.test.ts",
    "host/src/stardew-integration-module.test.ts",
    "host/src/integration-module.test.ts",
    "host/src/strict-bridge-json.ts",
    "host/src/strict-bridge-json.test.ts",
    "host/src/named-pipe.ts",
    "host/src/local-stardew-bridge.ts",
    "host/src/local-stardew-bridge.test.ts",
    "host/src/schema-contract.test.ts",
    "host/src/farmhand-action-projection-characterization.test.ts",
    "host/src/stardew-integration-launcher.ts",
    "host/src/stardew-integration-launcher.test.ts",
    "host/src/integration-launcher.ts",
    "host/src/integration-launcher.test.ts",
    "host/src/runtime.ts",
    "host/src/runtime.test.ts",
    "host/src/farmhand-companion-preview.ts",
    "host/src/farmhand-companion-preview.test.ts",
    "host/src/stardew-execution-recovery-supervisor.ts",
    "host/src/stardew-execution-recovery-supervisor.test.ts",
    "host/src/action-execution-coordinator.internal.ts",
    "host/src/action-execution-coordinator.internal.test.ts",
    "host/src/receipt-replay.ts",
    "host/src/receipt-replay.test.ts",
    "protocol/bridge-v1.schema.json",
    "tools/check-stardew-action-promotion.mjs",
    "tools/check-stardew-action-promotion.test.mjs",
    "tools/stardew-action-gate-descriptors.mjs",
    "tools/stardew-action-gate-descriptors.test.mjs",
    "tools/verify-stardew-action-projection.mjs",
    "tools/verify-stardew-action-projection.test.mjs",
    "tools/lib/stardew-native-smoke-harness-v1.mjs",
    "tools/verify-stardew-action-projection-local.ps1",
    "tools/verify-stardew-action-projection-p2c.ps1"
)

function Assert-P2OwnedPathHygiene {
    & git -C $projectRoot diff --check HEAD -- @P2OwnedPaths
    Assert-ExternalSuccess "git diff --check P2 owned paths"

    foreach ($relativePath in $P2OwnedPaths) {
        $path = Join-Path $projectRoot $relativePath
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "P2 owned path is missing: $relativePath"
        }
        $text = [System.IO.File]::ReadAllText($path)
        if ($text -match "(?m)[ \t]+$") {
            throw "P2 owned path has trailing whitespace: $relativePath"
        }
        if ($text -match "(?:\r?\n){3}$") {
            throw "P2 owned path has excess trailing blank lines: $relativePath"
        }
    }
}

Write-Phase "prerequisites"
if ([string]::IsNullOrWhiteSpace($GamePath)) {
    $GamePath = "D:\Steam\steamapps\common\Stardew Valley"
}
if (-not (Test-Path -LiteralPath $GamePath -PathType Container)) {
    throw "GAMEBUDDY_STARDEW_GAME_PATH does not identify a directory: $GamePath"
}

Write-Phase "farmhand-core-tests"
& dotnet test (Join-Path $projectRoot "integrations/stardew/tests/GameBuddy.Stardew.Core.Tests/GameBuddy.Stardew.Core.Tests.csproj") --configuration $Configuration
Assert-ExternalSuccess "GameBuddy.Stardew.Core.Tests"

Write-Phase "farmhand-integration-tests"
& dotnet test (Join-Path $projectRoot "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/GameBuddy.Stardew.Integration.Tests.csproj") --configuration $Configuration "-p:GamePath=$GamePath"
Assert-ExternalSuccess "GameBuddy.Stardew.Integration.Tests"

Write-Phase "farmhand-host-contract-compile"
Push-Location $projectRoot
try {
    $hostSourceRoot = Join-Path $projectRoot "host"
    $farmhandHostSources = @(
        "src/action-registry.ts",
        "src/action-registry.test.ts",
        "src/game-tools.ts",
        "src/game-tools.test.ts",
        "src/protocol.ts",
        "src/protocol.test.ts",
        "src/execution-correlation-ledger.ts",
        "src/execution-correlation-ledger.test.ts",
        "src/stardew-integration-module.ts",
        "src/stardew-integration-module.test.ts",
        "src/integration-module.test.ts",
        "src/strict-bridge-json.ts",
        "src/strict-bridge-json.test.ts",
        "src/named-pipe.ts",
        "src/local-stardew-bridge.ts",
        "src/local-stardew-bridge.test.ts",
        "src/schema-contract.test.ts",
        "src/farmhand-action-projection-characterization.test.ts",
        "src/stardew-integration-launcher.ts",
        "src/stardew-integration-launcher.test.ts",
        "src/integration-launcher.ts",
        "src/integration-launcher.test.ts",
        "src/runtime.ts",
        "src/runtime.test.ts",
        "src/farmhand-companion-preview.ts",
        "src/farmhand-companion-preview.test.ts",
        "src/action-execution-coordinator.internal.ts",
        "src/action-execution-coordinator.internal.test.ts",
        "src/stardew-execution-recovery-supervisor.ts",
        "src/stardew-execution-recovery-supervisor.test.ts",
        "src/receipt-replay.ts",
        "src/receipt-replay.test.ts"
    )
    Remove-Item -LiteralPath (Join-Path $hostSourceRoot "dist-p2c") -Recurse -Force -ErrorAction SilentlyContinue
    Push-Location $hostSourceRoot
    try {
        & pnpm exec tsc --target ES2024 --module NodeNext --moduleResolution NodeNext --strict --esModuleInterop --skipLibCheck --outDir dist-p2c --rootDir src --noEmitOnError @farmhandHostSources
        Assert-ExternalSuccess "Farmhand Host contract compile"

        Write-Phase "focused-compiled-host-routes"
        & node --test --test-concurrency=1 `
            dist-p2c/action-registry.test.js `
            dist-p2c/game-tools.test.js `
            dist-p2c/protocol.test.js `
            dist-p2c/execution-correlation-ledger.test.js `
            dist-p2c/stardew-integration-module.test.js `
            dist-p2c/integration-module.test.js `
            dist-p2c/strict-bridge-json.test.js `
            dist-p2c/local-stardew-bridge.test.js `
            dist-p2c/schema-contract.test.js `
            dist-p2c/farmhand-action-projection-characterization.test.js `
            dist-p2c/stardew-integration-launcher.test.js `
            dist-p2c/integration-launcher.test.js `
            dist-p2c/runtime.test.js `
            dist-p2c/farmhand-companion-preview.test.js `
            dist-p2c/action-execution-coordinator.internal.test.js `
            dist-p2c/stardew-execution-recovery-supervisor.test.js `
            dist-p2c/receipt-replay.test.js
        Assert-ExternalSuccess "focused compiled Host route tests"
    }
    finally {
        Pop-Location
    }

    Write-Phase "promotion-and-descriptors"
    & pnpm test:stardew-action-projection
    Assert-ExternalSuccess "pnpm test:stardew-action-projection"
    & pnpm check:stardew-action-surface
    Assert-ExternalSuccess "pnpm check:stardew-action-surface"

    Write-Phase "shared-harness-consumer-classes"
    & node --test --test-concurrency=1 (Join-Path $projectRoot "tools/verify-stardew-action-projection.test.mjs")
    Assert-ExternalSuccess "tools/verify-stardew-action-projection.test.mjs"
}
finally {
    Pop-Location
}

Write-Host "P2C aggregate gate passed."
