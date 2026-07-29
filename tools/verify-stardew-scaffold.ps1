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

foreach ($path in @($entryPath, $managerPath, $controllerPath, $bridgeProtocolPath, $bridgeSessionPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required Stardew embodiment source file is missing: $path"
    }
}

$entry = Get-Content -Raw $entryPath
foreach ($requiredText in @("public sealed class ModEntry : Mod", "public override void Entry(IModHelper helper)", "GameLaunched", "SaveLoaded", "UpdateTicked", "ReturnedToTitle", "Game1.player")) {
    if (-not $entry.Contains($requiredText)) {
        throw "ModEntry.cs is missing required lifecycle/local-player binding text: $requiredText"
    }
}

$allSource = (Get-ChildItem -LiteralPath $modRoot -Filter "*.cs" -File | Get-Content -Raw) -join "`n"
foreach ($forbiddenText in @("new Farmer", "Game1.otherFarmers", "new NPC", "HttpClient", "WebSocket", "TcpListener", "UdpClient", "Game1.warpFarmer")) {
    if ($allSource.Contains($forbiddenText)) {
        throw "Stardew embodiment contains forbidden Phase 1 surface: $forbiddenText"
    }
}

foreach ($requiredText in @("UniqueMultiplayerID", "TryStart", "Cancel", "RequestLocalMove", "body_owned", "locally_blocked", "target_reached", "deadline_expired", "cancellation_receipt_missing", "MaximumRememberedReceipts", "CreateBridgeSnapshot", "BridgeProtocol.Version", "MaximumMessageBytes", "PartiallySucceeded", "ToWireValue", "TryAuthenticate", "TryObserve", "TryCancel", "FixedTimeEquals")) {
    if (-not $allSource.Contains($requiredText)) {
        throw "Stardew embodiment is missing required fail-closed/trace contract text: $requiredText"
    }
}

Write-Host "GameBuddy Stardew Phase 1 local-embodiment static validation passed."
