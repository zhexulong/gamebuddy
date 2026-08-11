[CmdletBinding()]
param(
    [string]$ProjectRoot
)

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")
}

$modRoot = Join-Path $ProjectRoot "integrations/stardew"
$manifestPath = Join-Path $modRoot "manifest.json"
$entryPath = Join-Path $modRoot "ModEntry.cs"
$managerPath = Join-Path $modRoot "ExecutionManager.cs"
$controllerPath = Join-Path $modRoot "StardewBodyController.cs"
$bridgeProtocolPath = Join-Path $modRoot "BridgeProtocol.cs"
$bridgeSessionPath = Join-Path $modRoot "BridgeSession.cs"
$localPipeBridgePath = Join-Path $modRoot "LocalPipeBridge.cs"
$portfolioProtocolPath = Join-Path $modRoot "PortfolioBridgeProtocol.cs"
$portfolioSessionPath = Join-Path $modRoot "PortfolioBridgeSession.cs"
$portfolioIntegrationPath = Join-Path $modRoot "PortfolioIntegration.cs"
$portfolioPipeBridgePath = Join-Path $modRoot "PortfolioLocalPipeBridge.cs"
$portfolioBindingPath = Join-Path $modRoot "PortfolioLocalPlayerBinding.cs"

$manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
$required = @("Name", "Author", "Version", "Description", "UniqueID", "EntryDll", "MinimumApiVersion")
foreach ($property in $required) {
    if ([string]::IsNullOrWhiteSpace([string]$manifest.$property)) {
        throw "manifest.json is missing required '$property'."
    }
}

if ($manifest.EntryDll -ne "GameBuddy.Stardew.dll") {
    throw "manifest.json must declare the GameBuddy assembly."
}

$semanticVersion = [version]::new(0, 0)
if (-not [version]::TryParse($manifest.Version, [ref]$semanticVersion) -or $semanticVersion -lt [version]::new(0, 1)) {
    throw "manifest.json must contain a valid, non-zero SMAPI version."
}

foreach ($path in @($entryPath, $managerPath, $controllerPath, $bridgeProtocolPath, $bridgeSessionPath, $localPipeBridgePath, $portfolioProtocolPath, $portfolioSessionPath, $portfolioIntegrationPath, $portfolioPipeBridgePath, $portfolioBindingPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required Stardew embodiment source file is missing: $path"
    }
}

$entry = Get-Content -Raw $entryPath
$portfolioIntegration = Get-Content -Raw $portfolioIntegrationPath
foreach ($requiredText in @("public sealed partial class ModEntry : Mod", "public override void Entry(IModHelper helper)", "GameLaunched", "SaveLoaded", "UpdateTicked", "ReturnedToTitle", "Game1.player")) {
    if (-not $entry.Contains($requiredText)) {
        throw "ModEntry.cs is missing required lifecycle/local-player binding text: $requiredText"
    }
}

if ($portfolioIntegration.Split('PortfolioLocalPlayerBinding.IsPinnedRuntimeVersion(Game1.version, Game1.versionBuildNumber)').Count -lt 3) {
    throw "Portfolio binding must verify the actual target-version Game1 runtime before opening and while observing."
}

$allSource = (Get-ChildItem -LiteralPath $modRoot -Filter "*.cs" -File | Get-Content -Raw) -join "`n"
foreach ($forbiddenText in @("new Farmer", "Game1.otherFarmers", "new NPC", "HttpClient", "WebSocket", "TcpListener", "UdpClient", "Game1.warpFarmer")) {
    if ($allSource.Contains($forbiddenText)) {
        throw "Stardew embodiment contains forbidden Phase 1 surface: $forbiddenText"
    }
}

# `locally_blocked` belonged to the retired manual cardinal controller. Native
# PathFindController now reports terminal `native_path_ended` instead.
foreach ($requiredText in @("gamebuddy_farmhands", "Game1.getAllFarmers", "UniqueMultiplayerID", "PerScreen<ScreenEmbodimentState>", "Context.ScreenId", "TryStart", "Cancel", "RequestLocalMove", "cancel_active_execution", "gamebuddy_trace", "RequestLocalEquipTool", "gamebuddy_equip_tool_fixture", "tool_selected", "CurrentTool", "TryStart", "body_owned", "native_path_ended", "target_reached", "deadline_expired", "cancellation_receipt_missing", "MaximumRememberedReceipts", "CreateBridgeSnapshot", "BridgeProtocol.Version", "MaximumMessageBytes", "PartiallySucceeded", "ToWireValue", "TryAuthenticate", "TryObserve", "TryExecute", "TryCancel", "FixedTimeEquals", "HasValidLocalBridgeConfiguration", "EnabledActionSet", "NamedPipeServerStream", "DrainLocalPipeBridge", "PortfolioBridgeProtocol", "PortfolioSnapshot", "PortfolioLocalPipeBridge", "portfolio_target_version_mismatch", "Game1.versionBuildNumber")) {
    if (-not $allSource.Contains($requiredText)) {
        throw "Stardew embodiment is missing required fail-closed/trace contract text: $requiredText"
    }
}

Write-Host "GameBuddy Stardew Phase 1 local-embodiment static validation passed."
