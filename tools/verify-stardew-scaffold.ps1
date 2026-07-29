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

$manifest = Get-Content -Raw $manifestPath | ConvertFrom-Json
$required = @("Name", "Author", "Version", "Description", "UniqueID", "EntryDll", "MinimumApiVersion")
foreach ($property in $required) {
    if ([string]::IsNullOrWhiteSpace([string]$manifest.$property)) {
        throw "manifest.json is missing required '$property'."
    }
}

if ($manifest.EntryDll -ne "GameBuddy.Stardew.dll") {
    throw "manifest.json must declare the scaffold assembly."
}

$semanticVersion = [version]::new(0, 0)
if (-not [version]::TryParse($manifest.Version, [ref]$semanticVersion) -or $semanticVersion -lt [version]::new(0, 1)) {
    throw "manifest.json must contain a valid, non-zero SMAPI version."
}

$entry = Get-Content -Raw $entryPath
foreach ($requiredText in @("public sealed class ModEntry : Mod", "public override void Entry(IModHelper helper)", "GameLaunched", "ReturnedToTitle")) {
    if (-not $entry.Contains($requiredText)) {
        throw "ModEntry.cs is missing required Phase 0A lifecycle scaffold text: $requiredText"
    }
}

$forbidden = @("UpdateTicked", "Game1.", "new NPC", "HttpClient", "WebSocket", "ExecutionManager", "StardewBodyController")
foreach ($forbiddenText in $forbidden) {
    if ($entry.Contains($forbiddenText)) {
        throw "ModEntry.cs must remain lifecycle-only; found forbidden text: $forbiddenText"
    }
}

Write-Host "GameBuddy Stardew Phase 0A scaffold validation passed."
