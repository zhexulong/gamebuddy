[CmdletBinding()]
<#
.SYNOPSIS
  Thin parameterized shared-world (multiplayer) action driver.

.DESCRIPTION
  Runs ONE Stardew Game Action against the real two-process shared-world
  topology: a Player Host that loads a native LAN world, and an AI Farmhand
  client that attaches through the signed provisioning manifest and then owns
  the bridge.

  It deliberately does NOT use `start-farmhand-launcher.ps1`:
    * the launcher additionally requires an immutable production Host
      generation plus a Preview runtime, neither of which this lane needs;
    * the launcher mutates the shared A-host/A-ai-client profiles through the
      global fixture-profile transaction, whose lock is currently held by an
      unrelated interrupted transaction.

  Instead it materializes private copies of those profiles under a caller-owned
  root, deploys the given Release bundle into them, and drives the already
  proven host/attachment/AI-client sequence. It therefore shares no lock and
  no mutable state with any other lane.

  It is a driver only: it grants no capability, changes no action contract, and
  produces no publish/closure decision. Its output is diagnostic action evidence.
#>
param(
    [Parameter(Mandatory = $true)][string]$GamePath,
    [Parameter(Mandatory = $true)][string]$HostProfileRoot,
    [Parameter(Mandatory = $true)][string]$AiProfileRoot,
    [Parameter(Mandatory = $true)][string]$ProbeRoot,
    [Parameter(Mandatory = $true)][string]$ReleaseDir,
    [Parameter(Mandatory = $true)][string]$SessionDirectory,
    [Parameter(Mandatory = $true)][string]$SaveName,
    [Parameter(Mandatory = $true)][ValidatePattern('^[0-9]{6,20}$')][string]$ExpectedFarmhandId,
    [string]$Action = "",
    [string]$ResultFile = "",
    [string]$ScenarioIdentity = "",
    [switch]$DumpSpatial,
    [string]$DumpExperimental = "",
    [string]$ReachLocation = "",
    [ValidateRange(30, 300)][int]$TimeoutSeconds = 180,
    [switch]$AttachOnly,
    [string]$SmokeScript = "",
    # Cross-day lifecycle only: where the AI client writes its lifecycle evidence,
    # and how many frames it waits for the other player to reach the native ready
    # barrier before honestly reporting requires_other_player.
    [string]$SleepLifecycleEvidence = "",
    [ValidateRange(1, 36000)][int]$SleepReadyBarrierFrames = 300,
    # Farmers that must be online before either lifecycle may start. A co-op night
    # must not be advanced alone: a host that sleeps while its partner is still
    # connecting would satisfy the barrier by itself.
    [ValidateRange(1, 8)][int]$SleepMinimumOnlineFarmers = 2,
    # The Host is the *other* farmer in a co-op night. For the day to actually
    # roll over, its player must sleep too. Each process drives only its own
    # farmer through the same native lifecycle; neither marks the other ready.
    [string]$HostSleepLifecycleEvidence = ""
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$script:phase = "input_validation"
$script:hostProcess = $null
$script:aiProcess = $null
$previousLaunchGenerationPresent = Test-Path Env:GAMEBUDDY_STARDEW_LAUNCH_GENERATION
$previousLaunchGeneration = if ($previousLaunchGenerationPresent) { $env:GAMEBUDDY_STARDEW_LAUNCH_GENERATION } else { $null }

$smapi = Join-Path $GamePath "StardewModdingAPI.exe"
$hostLog = Join-Path $env:APPDATA "StardewValley\ErrorLogs\SMAPI-latest.txt"
$aiLog = Join-Path $env:APPDATA "StardewValley\ErrorLogs\SMAPI-latest.player-2.txt"

# The Host-side fixture scenario each wired action's precondition lives in, and
# the policy opt-in the AI client needs to have that action published.
#
# A shared-world action cannot establish its own precondition: the fixture must
# already exist on the Farm when the Farmhand lands there. The scenario is
# therefore driver-supplied per action, exactly as the native-local lane supplies
# it through its own fixture profile. Experimental actions additionally need the
# profile to opt into them under the version-1 default-consent policy; published
# actions (machine_inspect) must not be listed there.
$ACTION_SETUP = @{
    machine_inspect = @{ scenario = "native_machine_inspect_v1"; experimental = $false }
    ship_item       = @{ scenario = "native_ship_item_v1"; experimental = $true }
    chest_retrieve  = @{ scenario = "native_chest_retrieve_v1"; experimental = $true }
    pet_animal      = @{ scenario = "native_pet_animal_v1"; experimental = $true }
    # The cross-day lifecycle is a coordinated lifecycle, not a wire action: no
    # Host fixture precondition is needed beyond the Farmhand's own cabin and
    # bed, so the scenario is the move-only empty one. It is also not a policy
    # action, so the AI client must not list it under ExperimentalActions.
    sleep_lifecycle = @{ scenario = ""; experimental = $false }
}

function Assert-PathExists([string]$Path, [string]$Label, [string]$Kind = "Leaf") {
    if (-not (Test-Path -LiteralPath $Path -PathType $Kind)) { throw "Missing ${Label}: $Path" }
}

function Assert-AbsoluteDirectory([string]$Path, [string]$Label) {
    Assert-PathExists $Path $Label "Container"
    if (-not [System.IO.Path]::IsPathFullyQualified($Path)) { throw "$Label must be absolute: $Path" }
}

function Assert-NoStardewProcesses([string]$Phase) {
    $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -in @("StardewModdingAPI", "Stardew Valley", "StardewValley") })
    if ($running.Count -gt 0) {
        throw "Shared-world driver requires no pre-existing Stardew/SMAPI process before ${Phase} (PIDs: $($running.Id -join ','))."
    }
}

function Wait-LogMarker([string]$Path, [string]$Marker, [int]$Seconds = $TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        Start-Sleep -Milliseconds 250
        $content = if (Test-Path -LiteralPath $Path -PathType Leaf) { [string](Get-Content -Raw -LiteralPath $Path -ErrorAction SilentlyContinue) } else { "" }
        if (-not [string]::IsNullOrEmpty($content) -and $content.Contains($Marker)) { return $true }
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Read-Json([string]$Path) {
    # Windows PowerShell writes BOM when Set-Content is used; the Mod and the
    # Host tools both strip it, so strip it here as well to stay identical.
    return (Get-Content -Raw -LiteralPath $Path).Replace([string][char]0xFEFF, '') | ConvertFrom-Json
}

function Write-Json([string]$Path, $Value, [int]$Depth = 12) {
    $json = $Value | ConvertTo-Json -Depth $Depth
    [System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))
}

function New-RandomToken([int]$Bytes = 32) {
    $buffer = [byte[]]::new($Bytes)
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($buffer).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Deploy-ReleaseBundle([string]$ModRoot) {
    # SMAPI loads the Mod-local copy; the sidecar copy must stay byte-identical
    # because the fixture/loader contracts compare them.
    foreach ($target in @((Join-Path $ModRoot "Mods\GameBuddy"), (Join-Path $ModRoot "GameBuddy"))) {
        if (-not (Test-Path -LiteralPath $target -PathType Container)) { continue }
        foreach ($name in @("GameBuddy.Stardew.dll", "GameBuddy.Stardew.Core.dll", "GameBuddy.Stardew.deps.json")) {
            $source = Join-Path $ReleaseDir $name
            if (Test-Path -LiteralPath $source -PathType Leaf) {
                Copy-Item -LiteralPath $source -Destination (Join-Path $target $name) -Force
            }
        }
    }
}

function Start-Smapi([string]$ModsPath, [string]$LaunchGeneration) {
    $env:GAMEBUDDY_STARDEW_LAUNCH_GENERATION = $LaunchGeneration
    return Start-Process -FilePath $smapi -ArgumentList @("--mods-path", ('"{0}"' -f $ModsPath)) -WorkingDirectory $GamePath -PassThru
}

function Stop-Smapi($Process) {
    if ($null -eq $Process) { return }
    if ($Process.HasExited) { return }
    $Process.CloseMainWindow() | Out-Null
    Start-Sleep -Seconds 3
    if (-not $Process.HasExited) { $Process.Kill() }
}

try {
    $script:phase = "input_validation"
    Assert-PathExists $smapi "SMAPI launcher"
    Assert-AbsoluteDirectory $HostProfileRoot "HostProfileRoot"
    Assert-AbsoluteDirectory $AiProfileRoot "AiProfileRoot"
    Assert-AbsoluteDirectory $ReleaseDir "ReleaseDir"
    if (-not [System.IO.Path]::IsPathFullyQualified($ProbeRoot)) { throw "ProbeRoot must be absolute: $ProbeRoot" }
    if (-not [System.IO.Path]::IsPathFullyQualified($SessionDirectory)) { throw "SessionDirectory must be absolute: $SessionDirectory" }
    if ($SaveName -notmatch '^GameBuddyFixture[A-Za-z0-9_-]{1,96}$') { throw "SaveName must be a disposable GameBuddyFixture slot: $SaveName" }
    if (-not $AttachOnly -and -not $DumpSpatial -and [string]::IsNullOrWhiteSpace($Action) -and [string]::IsNullOrWhiteSpace($SmokeScript)) { throw "Action or -SmokeScript is required unless -AttachOnly or -DumpSpatial is set." }
    Assert-NoStardewProcesses "materialization"

    $script:phase = "materialize_profiles"
    $hostModsRoot = Join-Path $ProbeRoot "host"
    $aiModsRoot = Join-Path $ProbeRoot "ai"
    foreach ($root in @($hostModsRoot, $aiModsRoot)) {
        if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
        New-Item -ItemType Directory -Force -Path $root | Out-Null
    }
    Copy-Item -Path (Join-Path $HostProfileRoot '*') -Destination $hostModsRoot -Recurse -Force
    Copy-Item -Path (Join-Path $AiProfileRoot '*') -Destination $aiModsRoot -Recurse -Force
    Deploy-ReleaseBundle $hostModsRoot
    Deploy-ReleaseBundle $aiModsRoot

    $hostConfigPath = Join-Path $hostModsRoot "Mods\GameBuddy\config.json"
    $hostSidecarPath = Join-Path $hostModsRoot "GameBuddy\config.json"
    $aiConfigPath = Join-Path $aiModsRoot "Mods\GameBuddy\config.json"
    $aiSidecarPath = Join-Path $aiModsRoot "GameBuddy\config.json"
    foreach ($path in @($hostConfigPath, $hostSidecarPath, $aiConfigPath, $aiSidecarPath)) { Assert-PathExists $path "profile config" }

    if (Test-Path -LiteralPath $SessionDirectory) { Remove-Item -LiteralPath $SessionDirectory -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $SessionDirectory | Out-Null

    # One run-owned identity: the Host signs with the session token, the AI
    # client validates that signature, and the bridge pipe/token pair is what
    # the action smoke runner later connects to on the AI side.
    $sessionToken = New-RandomToken 32
    $pipeName = "gamebuddy_shared_" + [guid]::NewGuid().ToString("N")
    $bridgeToken = New-RandomToken 32

    $hostConfig = Read-Json $hostConfigPath
    $hostConfig.HostFarmhandProvisioning.SessionDirectory = $SessionDirectory
    $hostConfig.HostFarmhandProvisioning.SessionToken = $sessionToken
    $hostConfig.HostAutomation.SaveName = $SaveName
    $hostConfig.HostAutomation.Enable = $true
    $setup = $null
    if (-not [string]::IsNullOrWhiteSpace($Action)) {
        if (-not $ACTION_SETUP.ContainsKey($Action)) { throw "shared_world_action_not_wired:$Action" }
        $setup = $ACTION_SETUP[$Action]
        $hostConfig.HostAutomation.FixtureScenario = $setup.scenario
    } elseif ($DumpSpatial -and -not [string]::IsNullOrWhiteSpace($DumpExperimental)) {
        # A dump about an experimental action needs that action's precondition on
        # the Farm, exactly as a run does. Without a scenario the world is empty
        # of the very thing being inspected, so the dump reports an empty list --
        # which is indistinguishable from "the fixture placed nothing".
        $dumpScenario = $ACTION_SETUP[($DumpExperimental -split ",")[0]]
        if ($null -ne $dumpScenario) {
            $setup = $dumpScenario
            $hostConfig.HostAutomation.FixtureScenario = $dumpScenario.scenario
        }
    } elseif (-not [string]::IsNullOrWhiteSpace($SmokeScript) -and -not [string]::IsNullOrWhiteSpace($Action)) {
        # A custom probe may still run against a real fixture (so pathfinding
        # sees the actual Farm layout, not the cleared setup world), by naming
        # the same action the ACTION_SETUP entry points at.
        if ($ACTION_SETUP.ContainsKey($Action)) {
            $setup = $ACTION_SETUP[$Action]
            $hostConfig.HostAutomation.FixtureScenario = $setup.scenario
        }
    }
    $hostConfig.SaveId = $hostConfig.SaveId
    # A co-op night needs BOTH farmers asleep: each process runs the same native
    # lifecycle for its own farmer, declares only its own readiness, and the
    # native ready barrier advances the day once both are ready. Neither side
    # marks the other ready and neither calls NewDay directly.
    if ($Action -eq "sleep_lifecycle" -and -not [string]::IsNullOrWhiteSpace($HostSleepLifecycleEvidence)) {
        if (-not [System.IO.Path]::IsPathFullyQualified($HostSleepLifecycleEvidence)) {
            throw "HostSleepLifecycleEvidence must be absolute: $HostSleepLifecycleEvidence"
        }
        $hostConfig | Add-Member -NotePropertyName SleepLifecycle -NotePropertyValue @{
            Enable                  = $true
            EvidencePath            = $HostSleepLifecycleEvidence
            TimeoutSeconds          = [Math]::Max(30, $TimeoutSeconds)
            SettleFrameBudget       = 240
            ReadyBarrierFrameBudget = $SleepReadyBarrierFrames
            MinimumOnlineFarmers    = $SleepMinimumOnlineFarmers
        } -Force
    }
    Write-Json $hostConfigPath $hostConfig
    Write-Json $hostSidecarPath $hostConfig

    $aiConfig = Read-Json $aiConfigPath
    if ($null -ne $setup -and $setup.experimental) {
        $aiConfig.ExperimentalActions = @($Action)
    }
    # The cross-day lifecycle is opt-in Mod configuration, not a policy action.
    # It is enabled on the AI client only, because that is the process whose
    # Farmhand walks to its own cabin bed and declares readiness; the Host player
    # is a real human whose sleep stays their own decision.
    if ($Action -eq "sleep_lifecycle") {
        if ([string]::IsNullOrWhiteSpace($SleepLifecycleEvidence)) {
            throw "sleep_lifecycle requires -SleepLifecycleEvidence (an absolute path for the lifecycle evidence file)."
        }
        if (-not [System.IO.Path]::IsPathFullyQualified($SleepLifecycleEvidence)) {
            throw "SleepLifecycleEvidence must be absolute: $SleepLifecycleEvidence"
        }
        $aiConfig | Add-Member -NotePropertyName SleepLifecycle -NotePropertyValue @{
            Enable                  = $true
            EvidencePath            = $SleepLifecycleEvidence
            TimeoutSeconds          = [Math]::Max(30, $TimeoutSeconds)
            SettleFrameBudget       = 240
            ReadyBarrierFrameBudget = $SleepReadyBarrierFrames
            MinimumOnlineFarmers    = $SleepMinimumOnlineFarmers
        } -Force
    }
    # Diagnostic dumps have no scenario, so without this they advertise no experimental
    # action at all and every discovery list that depends on one reads as null -- which
    # looks like "nothing there" rather than "not published", and hides exactly the
    # facts a dump exists to show. `-DumpExperimental` names what to publish.
    if ($DumpSpatial -and -not [string]::IsNullOrWhiteSpace($DumpExperimental)) {
        $aiConfig.ExperimentalActions = @($DumpExperimental -split ',')
    }
    $aiConfig.FarmhandProvisioner.ManifestPath = (Join-Path $SessionDirectory "stardew-farmhand-manifest.json")
    $aiConfig.FarmhandProvisioner.SessionToken = $sessionToken
    $aiConfig.HostFarmhandProvisioning.SessionToken = $sessionToken
    $aiConfig.EnableLocalBridge = $true
    $aiConfig.PipeName = $pipeName
    $aiConfig.BridgeToken = $bridgeToken
    $aiConfig.SaveId = $hostConfig.SaveId
    $aiConfig.WorldId = $hostConfig.WorldId
    $aiConfig.PlayerId = $hostConfig.PlayerId
    $aiConfig.CompanionId = $hostConfig.CompanionId
    Write-Json $aiConfigPath $aiConfig
    Write-Json $aiSidecarPath $aiConfig

    $script:phase = "host_launch"
    Remove-Item -LiteralPath $hostLog -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $aiLog -Force -ErrorAction SilentlyContinue
    # Host and AI must attest as distinct launch generations, exactly as the
    # production launcher does; the Host role fails closed without one.
    $hostGeneration = [guid]::NewGuid().ToString("N")
    $script:hostProcess = Start-Smapi $hostModsRoot $hostGeneration

    $script:phase = "host_fixture_readiness"
    $marker = "HostAutomation native world ready for save '$SaveName'; native LAN server started."
    if (-not (Wait-LogMarker $hostLog $marker $TimeoutSeconds)) {
        $tail = if (Test-Path -LiteralPath $hostLog -PathType Leaf) { (Get-Content -Raw -LiteralPath $hostLog) } else { "host_log_missing" }
        throw "Host did not become native-LAN ready for '$SaveName'. Log tail: $($tail.Substring([Math]::Max(0, $tail.Length - 1500)))"
    }

    $script:phase = "attachment_request"
    $attachmentOutput = & node (Join-Path $PSScriptRoot "stardew-shared-world-attachment-request.mjs") `
        --session-directory $SessionDirectory `
        --host-config $hostConfigPath `
        --expected-farmhand-id $ExpectedFarmhandId `
        --timeout-ms ($TimeoutSeconds * 1000) 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Shared-world attachment request failed: $($attachmentOutput -join ' ')" }
    $attachment = ($attachmentOutput -join "`n") | ConvertFrom-Json

    $script:phase = "ai_client_launch"
    $aiGeneration = [guid]::NewGuid().ToString("N")
    $script:aiProcess = Start-Smapi $aiModsRoot $aiGeneration
    $clientAttached = Wait-LogMarker $aiLog "FarmhandProvisioner reached readyToPlay with the expected native Farmhand identity and save/world scope." $TimeoutSeconds
    if (-not $clientAttached) {
        $tail = if (Test-Path -LiteralPath $aiLog -PathType Leaf) { (Get-Content -Raw -LiteralPath $aiLog) } else { "ai_log_missing" }
        throw "AI Farmhand did not reach readyToPlay. Log tail: $($tail.Substring([Math]::Max(0, $tail.Length - 1500)))"
    }

    $result = [ordered]@{
        state           = "attached"
        topology        = "shared_world_farmhand"
        action          = $Action
        fixtureScenario = if ($null -eq $setup) { $null } else { $setup.scenario }
        saveName        = $SaveName
        farmhandId      = [string]$attachment.farmhandId
        companionId     = [string]$attachment.companionId
        cabinId         = [string]$attachment.cabinId
        requestId       = [string]$attachment.requestId
        sessionNoncePresent = [bool]$attachment.sessionNoncePresent
        hostModsRoot    = $hostModsRoot
        aiModsRoot      = $aiModsRoot
        aiClientConfig  = $aiConfigPath
        evidence        = "Host SMAPI log native-LAN readiness + signed attachment response/manifest + AI-client readyToPlay"
    }

    if (-not [string]::IsNullOrWhiteSpace($SmokeScript)) {
        # Custom diagnostics script. The ps1 owns topology materialization and
        # the two-process launch; the custom script is invoked only after both
        # are live, with the exact AI client config path so it can connect.
        # It must exit non-zero on failure and speak JSON on stdout.
        $script:phase = "action_smoke"
        $actionArgs = @("--client-config", $aiConfigPath)
        $smokeOutput = & node (Join-Path $PSScriptRoot $SmokeScript) @actionArgs 2>&1
        $smokeExit = $LASTEXITCODE
        $result.actionExitCode = $smokeExit
        $result.actionResult = ($smokeOutput -join "`n")
        $result.state = if ($smokeExit -eq 0) { "action_passed" } else { "action_failed" }
    } elseif (-not $AttachOnly) {
        $script:phase = "action_smoke"
        $actionArgs = @("--client-config", $aiConfigPath, "--action", $Action)
        if ($Action -eq "sleep_lifecycle") { $actionArgs += @("--lifecycle-evidence", $SleepLifecycleEvidence) }
        if ($DumpSpatial) {
            $actionArgs = @("--client-config", $aiConfigPath, "--dump-spatial", "--poll-trace")
            if (-not [string]::IsNullOrWhiteSpace($ReachLocation)) { $actionArgs += @("--reach-location", $ReachLocation) }
        }
        $smokeOutput = & node (Join-Path $PSScriptRoot "run-stardew-shared-world-action.mjs") @actionArgs 2>&1
        $smokeExit = $LASTEXITCODE
        $result.actionExitCode = $smokeExit
        $result.actionResult = ($smokeOutput -join "`n")
        $result.state = if ($smokeExit -eq 0) { "action_passed" } else { "action_failed" }
    }

    if (-not [string]::IsNullOrWhiteSpace($ResultFile)) {
        Write-Json ([System.IO.Path]::GetFullPath($ResultFile)) $result
    }
    $result | ConvertTo-Json -Depth 8
    if ($result.state -eq "action_failed") { exit 2 }
}
catch {
    $failure = $_
    [pscustomobject]@{
        state    = "blocked"
        phase    = $script:phase
        reason   = [string]$failure.Exception.Message
    } | ConvertTo-Json -Depth 4
    throw
}
finally {
    Stop-Smapi $script:aiProcess
    Stop-Smapi $script:hostProcess
    if ($previousLaunchGenerationPresent) {
        $env:GAMEBUDDY_STARDEW_LAUNCH_GENERATION = $previousLaunchGeneration
    } else {
        Remove-Item Env:GAMEBUDDY_STARDEW_LAUNCH_GENERATION -ErrorAction SilentlyContinue
    }
}
