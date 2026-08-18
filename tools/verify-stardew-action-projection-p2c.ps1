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

# P2 is a Farmhand-only static refactor. Keep hygiene tied to its explicit
# owners so unrelated dirty topology work cannot turn into a false P2 blocker.
# The list covers the Wave 1 + Wave 2 Farmhand full-pipeline owned paths:
#   - Mod authority/admission: ModConfig, BridgeProtocol, BridgeSession, router.
#   - Wave 2 handler family split: ExecutionManager.cs + every
#     ExecutionManager.*Handlers.cs partial that owns native handler families.
#   - Ordinary Farmhand terminal delivery/fixture boundary: LocalPipeBridge,
#     ModEntry (bridge wiring and fixture-only console admission).
#   - Farmhand-only C# contract sources: handler split projection contract and
#     bridge-interop contract (Program, tests, manifest, static runtime checks).
#     ProductionAssemblyBinding.cs is shared with the Portfolio contract and is
#     intentionally NOT P2-owned; Portfolio transport/topology stays excluded.
#   - Host cancel identity/completion projections: protocol, bridge client,
#     execution-correlation-ledger, stardew-integration-module and their tests.
#   - Host terminal-state/wake, receipt-order audit, coordinated cancel closure,
#     and explicit Farmhand relaunch/recovery composition: integration-launcher,
#     stardew-integration-launcher, action-execution-coordinator, receipt-replay,
#     runtime, farmhand-companion-preview, stardew-execution-recovery-supervisor
#     and their tests (pure node; no game or live dependency).
#   - Typed router handler contract and shared-harness consumer evidence
#     inputs: IFarmhandActionHandler.cs, FarmhandTypedReceiptContractTests.cs,
#     tools/lib/stardew-native-smoke-harness-v1.mjs.
#   - Descriptor identity: stardew-action-gate-descriptors and its focused test.
#   - Verifier consumer evidence: verify-stardew-action-projection and its focused
#     test (proves the three actual shared-harness consumer classes - read-only,
#     immediate mutation, delayed/multi-stage - from the descriptor/runner
#     identity/import without launching the game or issuing bridge actions).
#   - Verifier closure is covered by the owned-path list itself and the
#     focused node tests below; interop/live runner files stay outside the
#     non-live gate.
#   Shared-with-Portfolio test sources (CompanionPresentationPolicyTests.cs,
#   NativeChatPresentationPolicyTests.cs, ProductionAssemblyBinding.cs) stay
#   intentionally NOT P2-owned; Portfolio transport/topology stays excluded.
#   Live/interop classes stay intentionally OUTSIDE this non-live gate:
#   host/src/farmhand-bridge-interop.test.ts (built C# contract dll + dotnet +
#   immutable Host production artifact + real named-pipe round-trip) and all
#   tools/run-stardew-native-local-player-*.mjs runners (Stardew/SMAPI process
#   + native mutation) are covered by their own focused routes and the static
#   runner-identity proof only.
$P2OwnedPaths = @(
    "integrations/stardew/ModConfig.cs",
    "integrations/stardew/BridgeProtocol.cs",
    "integrations/stardew/BridgeSession.cs",
    "integrations/stardew/ExecutionManager.cs",
    "integrations/stardew/ExecutionManager.FarmingConstructionHandlers.cs",
    "integrations/stardew/ExecutionManager.GatheringHandlers.cs",
    "integrations/stardew/ExecutionManager.MachinesAnimalsItemsHandlers.cs",
    "integrations/stardew/ExecutionManager.MovementHandlers.cs",
    "integrations/stardew/ExecutionManager.ResourceToolHandlers.cs",
    "integrations/stardew/FarmhandActionRouter.cs",
    "integrations/stardew/IFarmhandActionHandler.cs",
    "integrations/stardew/LocalPipeBridge.cs",
    "integrations/stardew/ModEntry.cs",
    "integrations/stardew/tests/FarmhandActionCapabilityProjectionTests.cs",
    "integrations/stardew/tests/FarmhandActionCapabilityProjectionProgram.cs",
    "integrations/stardew/tests/FarmhandActionCapabilityProjection.Contract.csproj",
    "integrations/stardew/tests/FarmhandActionProjectionManifest.cs",
    "integrations/stardew/tests/FarmhandCapabilityRuntimeStaticTests.cs",
    "integrations/stardew/tests/FarmhandHandlerSplit.Contract.csproj",
    "integrations/stardew/tests/FarmhandHandlerSplitContractProgram.cs",
    "integrations/stardew/tests/FarmhandHandlerSplitContractTests.cs",
    "integrations/stardew/tests/FarmhandBridgeInteropProgram.cs",
    "integrations/stardew/tests/FarmhandBridgeInterop.Contract.csproj",
    "integrations/stardew/tests/FarmhandLocalPipeBridgeDeliveryTests.cs",
    "integrations/stardew/tests/FarmhandTypedReceiptContractTests.cs",
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
    throw "GAMEBUDDY_STARDEW_GAME_PATH is required for P2C because the compiled Mod projection verifier requires the licensed target-version Stardew + SMAPI installation. This non-live gate does not start or mutate the game."
}
if (-not (Test-Path -LiteralPath $GamePath -PathType Container)) {
    throw "GAMEBUDDY_STARDEW_GAME_PATH does not identify a directory: $GamePath"
}

Write-Phase "compiled-mod-projection-verifier"
& (Join-Path $projectRoot "tools/verify-stardew-action-projection-local.ps1") -GamePath $GamePath -Configuration $Configuration
Assert-ExternalSuccess "tools/verify-stardew-action-projection-local.ps1"

# Wave 2 lane C: the ordinary Farmhand bridge-interop contract proves the
# non-live hello/observe/presentation/player-control LocalPipeBridge session
# surface compiles against the same target-version assemblies. It is build-only
# here; its live pipe round-trip runs against the Host client in the
# farmhand-bridge-interop focused route, which is not part of this non-live gate.
$modAssembly = Join-Path $projectRoot "integrations/stardew/bin/$Configuration/net6.0/GameBuddy.Stardew.dll"
if (-not (Test-Path -LiteralPath $modAssembly -PathType Leaf)) {
    throw "Compiled Farmhand Mod assembly is missing after projection verification: $modAssembly"
}
$sha256 = [Security.Cryptography.SHA256]::Create()
try {
    $modAssemblySha256 = ([BitConverter]::ToString($sha256.ComputeHash([IO.File]::ReadAllBytes($modAssembly))) -replace "-", "").ToLowerInvariant()
}
finally {
    $sha256.Dispose()
}

Write-Phase "farmhand-handler-split-contract"
& dotnet build (Join-Path $projectRoot "integrations/stardew/tests/FarmhandHandlerSplit.Contract.csproj") --configuration $Configuration "-p:GamePath=$GamePath"
Assert-ExternalSuccess "integrations/stardew/tests/FarmhandHandlerSplit.Contract.csproj"
& dotnet (Join-Path $projectRoot "integrations/stardew/tests/bin/$Configuration/net6.0/FarmhandHandlerSplit.Contract.dll") --expected-sha256 $modAssemblySha256 $modAssembly --source-root (Join-Path $projectRoot "integrations/stardew")
Assert-ExternalSuccess "Farmhand handler-split contract"

Write-Phase "farmhand-terminal-delivery-contract"
& dotnet build (Join-Path $projectRoot "integrations/stardew/tests/FarmhandBridgeInterop.Contract.csproj") --configuration $Configuration "-p:GamePath=$GamePath"
Assert-ExternalSuccess "integrations/stardew/tests/FarmhandBridgeInterop.Contract.csproj"
& dotnet (Join-Path $projectRoot "integrations/stardew/tests/bin/$Configuration/net6.0/FarmhandBridgeInterop.Contract.dll") self-test
Assert-ExternalSuccess "Farmhand LocalPipeBridge terminal-delivery contract"

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

    # The consumer-class proof is static: it imports the actual gate descriptor
    # for runner identity, then reads the actual runner sources for the shared-
    # harness import and class markers. It never executes a runner smoke
    # contract, never launches Stardew, and never sends a bridge action.
    Write-Phase "shared-harness-consumer-classes"
    & node --test --test-concurrency=1 (Join-Path $projectRoot "tools/verify-stardew-action-projection.test.mjs")
    Assert-ExternalSuccess "tools/verify-stardew-action-projection.test.mjs"

    Write-Phase "owned-path-diff-hygiene"
    Assert-P2OwnedPathHygiene
}
finally {
    Pop-Location
}

Write-Host "P2C aggregate gate passed. The gate is non-live: it does not start Stardew, issue bridge action requests, or execute any runner smoke contract; shared-harness consumer-class evidence is static descriptor/runner identity/import, and the Host terminal-state/wake/coordinator/replay routes run as pure node compiled tests."