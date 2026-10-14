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
    # Empty ONLY for -ProvisionNewBinding: a new binding requires an empty expected id, and the empty id is
    # how the advertisement addresses an ownerless cabin.
    [ValidatePattern('^([0-9]{6,20})?$')][string]$ExpectedFarmhandId = "",
    [string]$Action = "",
    [string]$ResultFile = "",
    [string]$ScenarioIdentity = "",
    [switch]$DumpSpatial,
    [string]$DumpExperimental = "",
    [string]$ReachLocation = "",
    [ValidateRange(30, 300)][int]$TimeoutSeconds = 180,
    [switch]$AttachOnly,
    # One-time binding provision: attach into the world's EMPTY cabin, let the Host persist the binding through
    # its own native save, and stop at the manifest that save produced. The AI client is not started: nothing
    # consumes the bridge, and the identity is created by the Host's own provisioning authority. Every later run
    # passes the id this run reports.
    [switch]$ProvisionNewBinding,
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
# Readiness is judged from THIS run's own log streams first, never only from the machine-global SMAPI files.
#
# Those globals (`SMAPI-latest.txt` and its `player-2` sibling) are shared by every Stardew process on the machine,
# and this driver used to delete them at launch. So two concurrent shared-world runs destroyed each other's
# readiness evidence: the later launch erased the earlier one's marker, its Wait-LogMarker never saw it, and the
# run died at its timeout while the log showed the OTHER lane's save (measured 2026-10-14). Console output is now
# redirected per run, the waits take a list, and nothing deletes a file another run may be writing.
$LogRoot = Join-Path $ProbeRoot 'logs'
$hostLog = Join-Path $LogRoot 'host.stdout.log'
$hostErrorLog = Join-Path $LogRoot 'host.stderr.log'
$aiLog = Join-Path $LogRoot 'ai-client.stdout.log'
$aiErrorLog = Join-Path $LogRoot 'ai-client.stderr.log'
$sharedHostLog = Join-Path $env:APPDATA 'StardewValley\ErrorLogs\SMAPI-latest.txt'
$sharedAiLog = Join-Path $env:APPDATA 'StardewValley\ErrorLogs\SMAPI-latest.player-2.txt'

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
    # The cross-day lifecycle has two drivers, and the mapping differs because the
    # precondition differs:
    #
    #  - `sleep_lifecycle` is the Mod-internal evidence-file lane: it owns its own
    #    route and answer, so it needs no Host fixture precondition and is NOT a
    #    policy action (the AI client must not list it under ExperimentalActions).
    #  - `advance_day` is the wire action: the shared world dispatches it through
    #    the bridge like the actions above, so it needs the policy opt-in. It still
    #    needs no Host fixture precondition beyond the Farmhand's own cabin and
    #    bed, so its scenario is the move-only empty one.
    sleep_lifecycle = @{ scenario = ""; experimental = $false }
    advance_day     = @{ scenario = ""; experimental = $true }
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

function Wait-LogMarker([string[]]$Paths, [string]$Marker, [int]$Seconds = $TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        Start-Sleep -Milliseconds 250
        # Every candidate is polled: the per-run stream first (this launcher's own output), then the shared file as a
        # fallback for a SMAPI that writes only there. A marker is looked for in each, so a run cannot be fooled by
        # another run's content unless that content carries the same marker text.
        foreach ($candidate in $Paths) {
            if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
            $content = [string](Get-Content -Raw -LiteralPath $candidate -ErrorAction SilentlyContinue)
            if (-not [string]::IsNullOrEmpty($content) -and $content.Contains($Marker)) { return $true }
        }
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

function Start-Smapi([string]$ModsPath, [string]$LaunchGeneration, [string]$StdOut, [string]$StdErr) {
    $env:GAMEBUDDY_STARDEW_LAUNCH_GENERATION = $LaunchGeneration
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $StdOut) | Out-Null
    if (Test-Path -LiteralPath $StdOut) { Remove-Item -LiteralPath $StdOut -Force }
    if (Test-Path -LiteralPath $StdErr) { Remove-Item -LiteralPath $StdErr -Force }
    return Start-Process -FilePath $smapi -ArgumentList @("--mods-path", ('"{0}"' -f $ModsPath)) -WorkingDirectory $GamePath -PassThru -RedirectStandardOutput $StdOut -RedirectStandardError $StdErr
}

function Get-DriverLogTail([string[]]$Paths, [string]$MissingLabel) {
    foreach ($candidate in $Paths) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $content = Get-Content -Raw -LiteralPath $candidate
            if (-not [string]::IsNullOrWhiteSpace($content)) { return $content }
        }
    }
    return $MissingLabel
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
    if (-not $AttachOnly -and -not $ProvisionNewBinding -and -not $DumpSpatial -and [string]::IsNullOrWhiteSpace($Action) -and [string]::IsNullOrWhiteSpace($SmokeScript)) { throw "Action or -SmokeScript is required unless -AttachOnly or -DumpSpatial is set." }
    if (-not $ProvisionNewBinding -and [string]::IsNullOrEmpty($ExpectedFarmhandId)) {
        throw "ExpectedFarmhandId is required unless -ProvisionNewBinding is set: only a first provision may omit it, because a NEW binding requires an empty expected id (HostFarmhandProvisioner.cs:535)."
    }
    if ($ProvisionNewBinding -and -not [string]::IsNullOrEmpty($ExpectedFarmhandId)) {
        throw "ProvisionNewBinding requires an EMPTY -ExpectedFarmhandId: a non-empty one addresses an EXISTING farmhand (HostFarmhandProvisioner.cs:588)."
    }
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
    # A co-op night needs BOTH farmers asleep: each process drives its own farmer,
    # declares only its own readiness, and the native ready barrier advances the
    # day once both are ready. Neither side marks the other ready and neither calls
    # NewDay directly.
    #
    # This applies to both drivers of the same night. `sleep_lifecycle` is the
    # Mod-internal file lane on both sides; `advance_day` is the wire action on the
    # AI side, but the HOST side still has to go to bed, and driving it through the
    # same file lane is exactly what the mechanism-level co-op evidence did. The
    # Host player is a real human whose sleep is their own decision in production;
    # in this gate the Host side is driven so the barrier can actually complete.
    if ($Action -in @("sleep_lifecycle", "advance_day") -and -not [string]::IsNullOrWhiteSpace($HostSleepLifecycleEvidence)) {
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
    # A dispatched advance_day must not quietly become a solo night: if the other
    # player is still connecting the world looks single-player and the native path
    # would advance the day alone. This governs the WIRE action and is deliberately
    # separate from SleepLifecycle below, which arms the evidence-file lifecycle.
    if ($Action -eq "advance_day") {
        $aiConfig | Add-Member -NotePropertyName AdvanceDayMinimumOnlineFarmers -NotePropertyValue $SleepMinimumOnlineFarmers -Force
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
    # No shared file is deleted here: another run may be writing it, and the per-run files above are this run's own.
    # Host and AI must attest as distinct launch generations, exactly as the
    # production launcher does; the Host role fails closed without one.
    $hostGeneration = [guid]::NewGuid().ToString("N")
    $script:hostProcess = Start-Smapi $hostModsRoot $hostGeneration $hostLog $hostErrorLog

    $script:phase = "host_fixture_readiness"
    $marker = "HostAutomation native world ready for save '$SaveName'; native LAN server started."
    if (-not (Wait-LogMarker @($hostLog, $sharedHostLog) $marker $TimeoutSeconds)) {
        $tail = Get-DriverLogTail @($hostLog, $sharedHostLog) 'host_log_missing'
        throw "Host did not become native-LAN ready for '$SaveName'. Log tail: $($tail.Substring([Math]::Max(0, $tail.Length - 1500)))"
    }

    $script:phase = "attachment_request"
    $attachmentOutput = & node (Join-Path $PSScriptRoot "stardew-shared-world-attachment-request.mjs") `
        --session-directory $SessionDirectory `
        --host-config $hostConfigPath `
        --expected-farmhand-id "$ExpectedFarmhandId" `
        --timeout-ms ($TimeoutSeconds * 1000) 2>&1
    if ($LASTEXITCODE -ne 0) { throw "Shared-world attachment request failed: $($attachmentOutput -join ' ')" }
    $attachment = ($attachmentOutput -join "`n") | ConvertFrom-Json

    if ($ProvisionNewBinding) {
        # The Host's own provisioning authority created the Farmhand inside the empty cabin and asked for a native
        # save; the manifest is issued only after that save read back a valid binding
        # (HostFarmhandProvisioner.cs:260-262), so this marker IS the durable proof.
        $script:phase = "binding_save"
        $manifestMarker = "GameBuddy issued a signed Farmhand join manifest for companion profile '$($attachment.companionId)'."
        if (-not (Wait-LogMarker $hostLog $manifestMarker $TimeoutSeconds)) {
            $tail = if (Test-Path -LiteralPath $hostLog -PathType Leaf) { (Get-Content -Raw -LiteralPath $hostLog) } else { "host_log_missing" }
            throw "The Host did not persist and publish the new farmhand binding. Log tail: $($tail.Substring([Math]::Max(0, $tail.Length - 1500)))"
        }

        $provisioned = [ordered]@{
            state        = "binding_provisioned"
            topology     = "shared_world_farmhand"
            saveName     = $SaveName
            farmhandId   = [string]$attachment.farmhandId
            companionId  = [string]$attachment.companionId
            cabinId      = [string]$attachment.cabinId
            requestId    = [string]$attachment.requestId
            evidence     = "the Host's own provisioning authority created the Farmhand in the empty cabin, the native save persisted the binding, and the signed manifest was issued only after that readback"
            nextStep     = "every later gate passes -ExpectedFarmhandId $([string]$attachment.farmhandId)"
        }
        if (-not [string]::IsNullOrWhiteSpace($ResultFile)) {
            Write-Json $ResultFile $provisioned
        }
        $provisioned | ConvertTo-Json -Depth 6 -Compress
        return
    }

    $script:phase = "ai_client_launch"
    $aiGeneration = [guid]::NewGuid().ToString("N")
    $script:aiProcess = Start-Smapi $aiModsRoot $aiGeneration $aiLog $aiErrorLog
    $clientAttached = Wait-LogMarker @($aiLog, $sharedAiLog) "FarmhandProvisioner reached readyToPlay with the expected native Farmhand identity and save/world scope." $TimeoutSeconds
    if (-not $clientAttached) {
        $tail = Get-DriverLogTail @($aiLog, $sharedAiLog) 'ai_log_missing'
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
        if ($Action -eq "sleep_lifecycle") { $actionArgs += @("--lifecycle-evidence", $SleepLifecycleEvidence) }        if ($DumpSpatial) {
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
    $result | ConvertTo-Json -Depth 8 -Compress
    if ($result.state -eq "action_failed") { exit 2 }
}
catch {
    $failure = $_
    [pscustomobject]@{
        state    = "blocked"
        phase    = $script:phase
        reason   = [string]$failure.Exception.Message
    } | ConvertTo-Json -Depth 4 -Compress
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
