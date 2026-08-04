[CmdletBinding()]
param(
    [string]$GamePath = $env:GAMEBUDDY_STARDEW_GAME_PATH,
    [string]$SessionDirectory = $env:GAMEBUDDY_STARDEW_SESSION_DIRECTORY,
    [string]$ExpectedFarmhandId = $env:GAMEBUDDY_AI_FARMHAND_ID,
    [string]$ModConfigPath,
    [string]$HostModConfigPath,
    [string]$AiClientModConfigPath,
    [switch]$RequireRunningClients
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$checks = [System.Collections.Generic.List[object]]::new()
function Add-Check([string]$Name, [bool]$Passed, [string]$Detail) {
    $checks.Add([pscustomobject]@{
        name = $Name
        status = if ($Passed) { "pass" } else { "blocked" }
        detail = $Detail
    })
}

$gamePathValid = -not [string]::IsNullOrWhiteSpace($GamePath) -and (Test-Path -LiteralPath $GamePath -PathType Container)
Add-Check "game_path" $gamePathValid $(if ($gamePathValid) { $GamePath } else { "Set GAMEBUDDY_STARDEW_GAME_PATH to a licensed Stardew Valley installation." })

$smapiPath = if ($gamePathValid) { Join-Path $GamePath "StardewModdingAPI.exe" } else { "" }
$gameExePath = if ($gamePathValid) { Join-Path $GamePath "Stardew Valley.exe" } else { "" }
$defaultModConfigPath = if ($gamePathValid) { Join-Path $GamePath "Mods/GameBuddy/config.json" } else { "" }
if ([string]::IsNullOrWhiteSpace($ModConfigPath)) { $ModConfigPath = $defaultModConfigPath }
if ([string]::IsNullOrWhiteSpace($HostModConfigPath)) { $HostModConfigPath = $ModConfigPath }
$legacyPlayerIdFound = $false
function Read-Profile([string]$Name, [string]$Path, [string]$ParameterName) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        Add-Check $Name $false "GameBuddy config.json for this role was not found; pass -$ParameterName or deploy the profile."
        return $null
    }
    try {
        $profile = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
        Add-Check $Name $true "Found local GameBuddy profile; legacy fields are not formal provisioning authority."
        return $profile
    } catch {
        Add-Check $Name $false "GameBuddy config exists but is not valid JSON: $Path"
        return $null
    }
}
$hostConfig = Read-Profile "host_profile_config" $HostModConfigPath "HostModConfigPath"
$clientConfig = Read-Profile "ai_client_profile_config" $AiClientModConfigPath "AiClientModConfigPath"
$hostPlayerIdProperty = if ($null -ne $hostConfig) { $hostConfig.PSObject.Properties["PlayerId"] } else { $null }
$hostProvisioningProperty = if ($null -ne $hostConfig) { $hostConfig.PSObject.Properties["HostFarmhandProvisioning"] } else { $null }
$clientProvisioningProperty = if ($null -ne $clientConfig) { $clientConfig.PSObject.Properties["FarmhandProvisioner"] } else { $null }
if ($null -ne $hostPlayerIdProperty -and [string]$hostPlayerIdProperty.Value -match "^[0-9]{1,20}$") { $legacyPlayerIdFound = $true }
$hostProfileConfigured = $null -ne $hostProvisioningProperty -and $hostProvisioningProperty.Value.Enable -eq $true
$clientProfileConfigured = $null -ne $clientProvisioningProperty -and $clientProvisioningProperty.Value.Enable -eq $true
Add-Check "host_profile" $hostProfileConfigured $(if ($hostProfileConfigured) { "HostFarmhandProvisioning is enabled in the host profile." } else { "HostFarmhandProvisioning is not enabled in the host profile." })
Add-Check "ai_client_profile" $clientProfileConfigured $(if ($clientProfileConfigured) { "FarmhandProvisioner is enabled in the AI-client profile." } else { "FarmhandProvisioner is not enabled in the AI-client profile." })
Add-Check "role_separation" ($hostProfileConfigured -and $clientProfileConfigured -and $HostModConfigPath -ne $AiClientModConfigPath) "Host and AI-client roles must be enabled in separate Mod profiles."
$smapiValid = $gamePathValid -and (Test-Path -LiteralPath $smapiPath -PathType Leaf)
$gameExeValid = $gamePathValid -and (Test-Path -LiteralPath $gameExePath -PathType Leaf)
Add-Check "smapi_launcher" $smapiValid $(if ($smapiValid) { $smapiPath } else { "StardewModdingAPI.exe is missing from the licensed game directory." })
Add-Check "game_executable" $gameExeValid $(if ($gameExeValid) { $gameExePath } else { "Stardew Valley.exe is missing from the licensed game directory." })

$sessionValid = -not [string]::IsNullOrWhiteSpace($SessionDirectory) -and (Split-Path -Path $SessionDirectory -IsAbsolute)
Add-Check "session_directory" $sessionValid $(if ($sessionValid) { $SessionDirectory } else { "Set an absolute shared local session directory for Host/App/AI-client files." })

$idValid = -not [string]::IsNullOrWhiteSpace($ExpectedFarmhandId) -and $ExpectedFarmhandId -match "^[0-9]{1,20}$" -and [long]$ExpectedFarmhandId -gt 0
if ($legacyPlayerIdFound) {
    Add-Check "legacy_player_id_candidate" $true "Legacy Mod config contains a numeric PlayerId candidate; it is not accepted as formal authorization without explicit confirmation."
}
Add-Check "expected_native_farmhand_id" $idValid $(if ($idValid) { "Native Farmhand ID supplied explicitly." } else { "Set GAMEBUDDY_AI_FARMHAND_ID or pass -ExpectedFarmhandId to explicitly authorize the exact native Farmhand ID; legacy PlayerId is not used automatically." })

if ($RequireRunningClients) {
    $runningClients = @(Get-Process -Name "StardewValley" -ErrorAction SilentlyContinue)
    $runningValid = $runningClients.Count -ge 2
    Add-Check "two_running_clients" $runningValid $(if ($runningValid) { "$($runningClients.Count) StardewValley process(es) detected." } else { "A formal @game run requires separately controlled Host and AI-client processes; diagnostic single-client runs do not satisfy this gate." })
}

$blocked = @($checks | Where-Object status -eq "blocked")
[pscustomobject]@{
    gate = "stardew_phase1_prerequisites"
    formalPath = "HostFarmhandProvisioner + StardewAttachmentFlow + FarmhandProvisioner"
    hardScenarioEvidence = "not produced by this prerequisite check"
    checks = $checks
    status = if ($blocked.Count -eq 0) { "prerequisites_ready" } else { "blocked" }
} | ConvertTo-Json -Depth 5

if ($blocked.Count -gt 0) { exit 2 }
exit 0
