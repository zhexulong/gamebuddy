[CmdletBinding()]
param(
    [string]$ProjectRoot
)

if ([string]::IsNullOrWhiteSpace($ProjectRoot)) {
    $ProjectRoot = Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..\..\..\..")
}

$modRoot = Join-Path $ProjectRoot "integrations\stardew"
$manifestPath = Join-Path $modRoot "manifest.json"
$entryPath = Join-Path $modRoot "ModEntry.cs"
$managerPath = Join-Path $modRoot "farmhandexecutioncontroller.cs"
$controllerPath = Join-Path $modRoot "StardewBodyController.cs"
$bridgeProtocolPath = Join-Path $modRoot "src\Core\Protocol\BridgeProtocol.cs"
$bridgeSessionPath = Join-Path $modRoot "BridgeSession.cs"
$localPipeBridgePath = Join-Path $modRoot "LocalPipeBridge.cs"

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

foreach ($path in @($entryPath, $managerPath, $controllerPath, $bridgeProtocolPath, $bridgeSessionPath, $localPipeBridgePath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required Stardew embodiment source file is missing: $path"
    }
}

$entry = Get-Content -Raw $entryPath
foreach ($requiredText in @("public sealed partial class ModEntry : Mod", "public override void Entry(IModHelper helper)", "GameLaunched", "SaveLoaded", "UpdateTicked", "ReturnedToTitle", "Game1.player")) {
    if (-not $entry.Contains($requiredText)) {
        throw "ModEntry.cs is missing required lifecycle/local-player binding text: $requiredText"
    }
}

# Production embodiment sources only: the scaffold validates the lived Mod
# surface, not tests. Tests are excluded from both the required-text scan and
# the forbidden-surface scan.
$productionSources = Get-ChildItem -LiteralPath $modRoot -Filter "*.cs" -File -Recurse |
  Where-Object { $_.FullName -notmatch '\\tests\\' } |
  Get-Content -Raw
$allSource = $productionSources -join "`n"
# Strip line and block comments for the forbidden pass only; the required-text
# pass still uses the unmodified source. Comments are not scanned, so the
# `Game1.warpFarmer` texts that only document the native warp seam never trip it.
$codeOnly = [regex]::Replace($allSource, '(?m)//.*$', '')
$codeOnly = [regex]::Replace($codeOnly, '(?s)/\*.*?\*/', '')
# The native warp seam is a legitimate implementation now that the Phase 1
# restriction has lapsed: `select_mine_elevator_floor`'s floor-0 branch is a
# faithful copy of MineElevatorMenu's own warp
# (farmhandexecutioncontroller.mineelevatoractions.cs), and the ModEntry
# mine-elevator Given stages its arrival through the game's own transition
# (ModEntry.Fixtures.MineElevator.cs). Only these two exact call expressions are
# admitted, each exactly once; every other warp surface still fails, and a Mod
# source tree without them is not the surface this allowlist describes.
$admittedWarpCalls = @(
    'Game1.warpFarmer(MineEntranceLocation, MineEntranceTileX, MineEntranceTileY, flip: true)',
    'Game1.warpFarmer(MineElevatorFixtureLevel, MineElevatorFixtureTileX, MineElevatorFixtureTileY, 2)'
)
$forbiddenScan = $codeOnly
foreach ($admittedWarpCall in $admittedWarpCalls) {
    $admittedWarpIndex = $forbiddenScan.IndexOf($admittedWarpCall)
    if ($admittedWarpIndex -lt 0) {
        throw "Stardew embodiment is missing the admitted native warp seam: $admittedWarpCall"
    }
    $forbiddenScan = $forbiddenScan.Remove($admittedWarpIndex, $admittedWarpCall.Length)
}
foreach ($forbiddenText in @("new Farmer", "Game1.otherFarmers", "new NPC", "HttpClient", "WebSocket", "TcpListener", "UdpClient", "Game1.warpFarmer")) {
    if ($forbiddenScan.Contains($forbiddenText)) {
        throw "Stardew embodiment contains forbidden Phase 1 surface: $forbiddenText"
    }
}

foreach ($requiredText in @("gamebuddy_farmhands", "Game1.getAllFarmers", "UniqueMultiplayerID", "PerScreen<ScreenEmbodimentState>", "Context.ScreenId", "TryStart", "Cancel", "RequestLocalMove", "cancel_active_execution", "gamebuddy_trace", "RequestLocalEquipTool", "gamebuddy_equip_tool_fixture", "CurrentTool", "TryStart", "body_owned", "native_path_ended", "target_reached", "deadline_expired", "cancellation_receipt_missing", "MaximumRememberedReceipts", "CreateBridgeSnapshot", "BridgeProtocol.Version", "MaximumMessageBytes", "PartiallySucceeded", "ToWireValue", "TryAuthenticate", "TryObserve", "TryExecute", "TryCancel", "FixedTimeEquals", "HasValidLocalBridgeConfiguration", "EnabledActionSet", "NamedPipeServerStream", "DrainLocalPipeBridge")) {
    if (-not $allSource.Contains($requiredText)) {
        throw "Stardew embodiment is missing required fail-closed/trace contract text: $requiredText"
    }
}

Write-Host "GameBuddy Stardew Phase 1 local-embodiment static validation passed."
