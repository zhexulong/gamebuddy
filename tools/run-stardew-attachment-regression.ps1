[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$GamePath,

    [Parameter(Mandatory = $true)]
    [string]$HostModsPath,

    [Parameter(Mandatory = $true)]
    [string]$AiClientModsPath,

    [Parameter(Mandatory = $true)]
    [string]$HostConfigPath,

    [Parameter(Mandatory = $true)]
    [string]$SaveName,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9]{6,20}$')]
    [string]$ExpectedFarmhandId,

    [Parameter(Mandatory = $true)]
    [string]$SessionDirectory,

    [ValidateRange(30, 300)]
    [int]$TimeoutSeconds = 120,

    [switch]$KeepProcesses
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
# Native Node failures are captured and classified through `$LASTEXITCODE` by
# Wait-FixtureReadiness; prevent PowerShell from promoting their stderr text to
# a terminating NativeCommandError before that logic runs.
$PSNativeCommandUseErrorActionPreference = $false

$smapi = Join-Path $GamePath "StardewModdingAPI.exe"
$hostLog = Join-Path $env:APPDATA "StardewValley\ErrorLogs\SMAPI-latest.txt"
$clientLog = Join-Path $env:APPDATA "StardewValley\ErrorLogs\SMAPI-latest.player-2.txt"
$manifestPath = Join-Path $SessionDirectory "stardew-farmhand-manifest.json"
$oldManifestPath = Join-Path $SessionDirectory "stardew-farmhand-manifest.regression-old.json"
$telemetryPath = Join-Path $SessionDirectory "stardew-attachment-telemetry.json"

foreach ($path in @($smapi, $HostModsPath, $AiClientModsPath, $HostConfigPath)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing regression path: $path" }
}
if (-not (Split-Path -Path $SessionDirectory -IsAbsolute)) { throw "SessionDirectory must be absolute." }
New-Item -ItemType Directory -Force -Path $SessionDirectory | Out-Null
# The Node readiness verifier requires canonical absolute paths. Resolve only
# after the existing file/absolute-session guards, so a caller may still pass
# a conventional relative Host config without loosening session ownership.
$HostConfigPath = (Resolve-Path -LiteralPath $HostConfigPath).Path
$SessionDirectory = (Resolve-Path -LiteralPath $SessionDirectory).Path

$hostProcess = $null
$clientProcess = $null
$results = [ordered]@{}
# This telemetry is operational timing only. It is never HMAC-signed,
# never a bridge receipt, and never action/attachment success evidence.
$telemetry = [ordered]@{
    schemaVersion = 1
    kind = "stardew_attachment_regression_timing"
    authority = "non_authoritative_diagnostic"
    startedAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    saveName = $SaveName
    stages = [ordered]@{}
    outcome = "running"
}

function Invoke-TelemetryStage([string]$Name, [scriptblock]$Action) {
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $value = & $Action
        $telemetry.stages[$Name] = [ordered]@{ state = "passed"; elapsedMs = [int64]$watch.ElapsedMilliseconds }
        return $value
    } catch {
        $telemetry.stages[$Name] = [ordered]@{ state = "failed"; elapsedMs = [int64]$watch.ElapsedMilliseconds; errorType = $_.Exception.GetType().Name }
        throw
    } finally {
        $watch.Stop()
    }
}

function Publish-Telemetry([string]$Outcome) {
    $telemetry.outcome = $Outcome
    $telemetry.finishedAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $telemetry.elapsedMs = [int64]($telemetry.finishedAtUnixMs - $telemetry.startedAtUnixMs)
    $temp = "$telemetryPath.tmp"
    try {
        # Windows PowerShell's UTF8 encoding prepends a BOM, while the
        # telemetry reader is deliberately plain JSON (Node JSON.parse). Use a
        # no-BOM UTF-8 writer; this remains operational diagnostics only.
        $json = $telemetry | ConvertTo-Json -Depth 8
        [IO.File]::WriteAllText($temp, $json, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temp -Destination $telemetryPath -Force
    } finally {
        Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue
    }
}

function Clear-GeneratedFile([string]$Path) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

function Clear-SessionExchange {
    foreach ($name in @(
        "stardew-session.json",
        "stardew-attachment-request.json",
        "stardew-attachment-response.json",
        "stardew-farmhand-manifest.json",
        "stardew-farmhand-manifest.regression-old.json",
        "stardew-fixture-readiness.json",
        "stardew-fixture-readiness.stdout",
        "stardew-fixture-readiness.stderr"
    )) {
        Clear-GeneratedFile (Join-Path $SessionDirectory $name)
    }
}

function Start-SmapI([string]$ModsPath) {
    Start-Process -FilePath $smapi -ArgumentList @("--mods-path", $ModsPath) -WorkingDirectory $GamePath -PassThru
}

function Stop-SmapI([System.Diagnostics.Process]$Process) {
    if ($null -eq $Process) { return }
    $processId = $Process.Id
    $current = Get-Process -Id $processId -ErrorAction SilentlyContinue
    if ($null -eq $current) { return }

    # Never request CloseMainWindow here: Stardew turns it into an in-game save,
    # which can take an unbounded time and does not prove the host observed the
    # separate client disconnect required by this regression. A forced client
    # exit is deliberate; the HostAutomation fixture must then observe it and
    # drive its own real native Saving/Saved lifecycle.
    try { Stop-Process -Id $processId -Force -ErrorAction Stop } catch { }
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    do {
        Start-Sleep -Milliseconds 250
        $current = Get-Process -Id $processId -ErrorAction SilentlyContinue
    } while ($null -ne $current -and [DateTime]::UtcNow -lt $deadline)
    if ($null -ne $current) { throw "SMAPI process $processId did not terminate after forced exit." }
}

function Wait-FixtureReadiness([System.Diagnostics.Process]$Process, [long]$NotBeforeUnixMs) {
    # The readiness document is Host-authenticated HMAC data. Invoke the Node
    # verifier synchronously so `$LASTEXITCODE` is authoritative. In this
    # Windows/PowerShell environment Start-Process may retain a null ExitCode
    # even after WaitForExit, turning a verified fixture-ready report into a
    # false failure. The helper itself has the same bounded timeout; no AI
    # client or attachment request is started until it returns successfully.
    # Capture stdout/stderr separately so Node's own nonzero status can be
    # classified through `$LASTEXITCODE`, without PowerShell promoting stderr
    # into a NativeCommandError before the fail-fast reason is reported.
    $outputPath = Join-Path $SessionDirectory "stardew-fixture-readiness.stdout"
    $errorPath = Join-Path $SessionDirectory "stardew-fixture-readiness.stderr"
    $fixtureReportPath = Join-Path $SessionDirectory "stardew-fixture-readiness.json"
    $priorErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        & node (Join-Path $PSScriptRoot "await-stardew-fixture-readiness.mjs") `
            "--session-directory" $SessionDirectory `
            "--host-config" $HostConfigPath `
            "--timeout-ms" ($TimeoutSeconds * 1000) `
            "--not-before-unix-ms" $NotBeforeUnixMs `
            1> $outputPath 2> $errorPath
        $exitCode = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $priorErrorActionPreference
    }
    $output = if (Test-Path -LiteralPath $outputPath) { Get-Content -Raw -LiteralPath $outputPath } else { "" }
    $error = if (Test-Path -LiteralPath $errorPath) { Get-Content -Raw -LiteralPath $errorPath } else { "" }
    Clear-GeneratedFile $outputPath
    Clear-GeneratedFile $errorPath
    $combinedOutput = "$error$output"
    if ($exitCode -ne 0) {
        # On Windows the child can exit during a timeout race; `HasExited`
        # may be stale and the readiness report is often the only durable
        # fixture diagnostic. Preserve its bounded metadata without trusting
        # it as success/evidence, so the runner reports a useful fail-fast
        # cause rather than a raw ENOENT/timeout wrapper.
        $reportHint = ""
        if (Test-Path -LiteralPath $fixtureReportPath) {
            try {
                $report = Get-Content -Raw -LiteralPath $fixtureReportPath | ConvertFrom-Json
                $reportHint = "; report_state=$([string]$report.state); report_reason=$([string]$report.reasonCode)"
            } catch { $reportHint = "; report_state=unreadable" }
        }
        if ($Process.HasExited) { throw "Host SMAPI exited before fixture readiness${reportHint}: $combinedOutput" }
        throw "Fixture preflight failed${reportHint}: $combinedOutput"
    }
    try {
        $readiness = $output | ConvertFrom-Json
        if ([string]$readiness.state -notin @("fixture_ready", "not_required")) { throw "invalid_readiness_state" }
        return $readiness
    } catch {
        throw "Fixture preflight returned invalid readiness output: $combinedOutput"
    }
}

function Wait-HostReady([System.Diagnostics.Process]$Process) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $marker = "HostAutomation native world ready for save '$SaveName'; native LAN server started."
    do {
        Start-Sleep -Milliseconds 500
        if ($Process.HasExited) { throw "Host SMAPI exited before native readiness." }
        $loaded = (Test-Path -LiteralPath $hostLog -PathType Leaf) -and ((Get-Content -Raw -LiteralPath $hostLog -ErrorAction SilentlyContinue) -match [regex]::Escape($marker))
        # The marker is emitted only after the target-version native
        # Multiplayer.StartServer() returned with Game1.server present. Avoid
        # Get-NetUDPEndpoint here: on some Windows/MSYS environments that
        # cmdlet can block indefinitely and obscure the bounded runner timeout.
    } until ($loaded -or [DateTime]::UtcNow -ge $deadline)
    if (-not $loaded) { throw "Host did not become native-LAN ready." }
}

function Wait-LogMarker([string]$Path, [string]$Marker, [int]$Seconds = $TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        Start-Sleep -Milliseconds 250
        $content = if (Test-Path -LiteralPath $Path) { [string](Get-Content -Raw -LiteralPath $Path -ErrorAction SilentlyContinue) } else { "" }
        if ([string]::IsNullOrEmpty($content) -eq $false -and $content.Contains($Marker)) { return $true }
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Wait-FormalHostReady([switch]$RequireExpectedFarmhandOffline) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $path = Join-Path $SessionDirectory "stardew-session.json"
    do {
        Start-Sleep -Milliseconds 250
        if (Test-Path -LiteralPath $path) {
            try {
                $advertisement = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
                if ([string]$advertisement.state -ne "ready") { continue }
                if ($RequireExpectedFarmhandOffline) {
                    $cabins = @($advertisement.cabins | Where-Object {
                        [string]$_.ownerFarmhandId -eq $ExpectedFarmhandId
                    })
                    if ($cabins.Count -ne 1 -or [bool]$cabins[0].isBusy) { continue }
                }
                return $advertisement
            } catch { }
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    $state = if (Test-Path -LiteralPath $path) { [string](Get-Content -Raw -LiteralPath $path | ConvertFrom-Json).state } else { "missing" }
    $offlineRequirement = if ($RequireExpectedFarmhandOffline) { "; expected_farmhand_offline=false" } else { "" }
    throw "Formal Host advertisement did not become ready; final_state=$state$offlineRequirement"
}

function Get-HostSaveCompletedCount {
    if (-not (Test-Path -LiteralPath $hostLog)) { return 0 }
    return [int](Select-String -LiteralPath $hostLog -Pattern "Context: after save" -SimpleMatch -ErrorAction SilentlyContinue | Measure-Object).Count
}

function Wait-HostSaveCompleted([int]$BaselineCount) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        Start-Sleep -Milliseconds 250
        if ((Get-HostSaveCompletedCount) -gt $BaselineCount) { return }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Host did not complete a native Saving/Saved cycle after AI-client exit."
}

function Invoke-AttachmentRequest {
    $output = & node (Join-Path $PSScriptRoot "stardew-attachment-request.mjs") `
        --session-directory $SessionDirectory `
        --host-config $HostConfigPath `
        --expected-farmhand-id $ExpectedFarmhandId `
        --timeout-ms ($TimeoutSeconds * 1000) 2>&1
    if ($LASTEXITCODE -ne 0) { throw "App attachment request failed: $($output -join " ")" }
    return ($output -join "`n" | ConvertFrom-Json)
}

function Start-AiClientAndWaitForMod {
    Clear-GeneratedFile $clientLog
    $script:clientProcess = Start-SmapI $AiClientModsPath
    $loaded = Wait-LogMarker $clientLog "GameBuddy health: SMAPI lifecycle hooks are available" $TimeoutSeconds
    if (-not $loaded) {
        $failure = if (Test-Path -LiteralPath $clientLog) { Get-Content -Raw -LiteralPath $clientLog } else { "client_log_missing" }
        throw "Formal AI-client Mod did not reach title-ready state: $failure"
    }
    return $true
}

function Wait-ForAiClientReady {
    $ready = Wait-LogMarker $clientLog "FarmhandProvisioner reached readyToPlay with the expected native Farmhand identity and save/world scope."
    if (-not $ready) {
        $failure = if (Test-Path -LiteralPath $clientLog) { Get-Content -Raw -LiteralPath $clientLog } else { "client_log_missing" }
        throw "Formal AI-client did not reach readyToPlay: $failure"
    }
    return $true
}

try {
    Clear-SessionExchange
    # Preserve a completed/failed run's telemetry for diagnosis, but never let
    # an older artifact impersonate timing from the launch about to begin.
    Clear-GeneratedFile $telemetryPath
    Clear-GeneratedFile $hostLog
    Clear-GeneratedFile $clientLog

    $firstHostLaunchAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $hostProcess = Invoke-TelemetryStage "initial_host_launch" { Start-SmapI $HostModsPath }
    $fixtureReadiness = Invoke-TelemetryStage "initial_fixture_readiness" { Wait-FixtureReadiness $hostProcess $firstHostLaunchAtUnixMs }
    $results.fixtureReadiness = $fixtureReadiness
    Invoke-TelemetryStage "initial_native_lan_ready" { Wait-HostReady $hostProcess } | Out-Null
    $firstSession = Invoke-TelemetryStage "initial_formal_host_ready" { Wait-FormalHostReady }
    $firstNonce = [string]$firstSession.nonce
    $saveCountBeforeInitialAttachment = Get-HostSaveCompletedCount
    Invoke-TelemetryStage "initial_ai_client_title_ready" { Start-AiClientAndWaitForMod } | Out-Null
    $firstRequest = Invoke-TelemetryStage "initial_attachment_request" { Invoke-AttachmentRequest }
    $results.initialAttachment = $firstRequest
    Invoke-TelemetryStage "initial_ai_client_game_ready" { Wait-ForAiClientReady } | Out-Null
    # The manifest is issued only after Saved, but wait for the fixture's
    # independent post-save marker before taking an exit baseline. Otherwise
    # the attachment save itself can be mistaken for the later client-exit save.
    Invoke-TelemetryStage "initial_attachment_native_save" { Wait-HostSaveCompleted $saveCountBeforeInitialAttachment } | Out-Null
    $saveCountBeforeInitialClientExit = Get-HostSaveCompletedCount
    $results.initialAiClientReady = $true
    Invoke-TelemetryStage "initial_ai_client_exit" { Stop-SmapI $clientProcess } | Out-Null
    $clientProcess = $null
    Invoke-TelemetryStage "initial_client_exit_native_save" { Wait-HostSaveCompleted $saveCountBeforeInitialClientExit } | Out-Null
    $results.saveAfterInitialClientExit = $true
    Invoke-TelemetryStage "initial_farmhand_offline" { Wait-FormalHostReady -RequireExpectedFarmhandOffline } | Out-Null

    $saveCountBeforeReconnectAttachment = Get-HostSaveCompletedCount
    # Never let a reconnect consume the previous request's manifest. The
    # client must wait for the newly confirmed request and its fresh save gate.
    Clear-GeneratedFile $manifestPath
    Invoke-TelemetryStage "reconnect_ai_client_title_ready" { Start-AiClientAndWaitForMod } | Out-Null
    $reconnectRequest = Invoke-TelemetryStage "reconnect_attachment_request" { Invoke-AttachmentRequest }
    $results.reconnectAttachment = $reconnectRequest
    Invoke-TelemetryStage "reconnect_ai_client_game_ready" { Wait-ForAiClientReady } | Out-Null
    Invoke-TelemetryStage "reconnect_attachment_native_save" { Wait-HostSaveCompleted $saveCountBeforeReconnectAttachment } | Out-Null
    $saveCountBeforeReconnectClientExit = Get-HostSaveCompletedCount
    $results.sameHostReconnectReady = $true
    Invoke-TelemetryStage "reconnect_ai_client_exit" { Stop-SmapI $clientProcess } | Out-Null
    $clientProcess = $null
    Invoke-TelemetryStage "reconnect_client_exit_native_save" { Wait-HostSaveCompleted $saveCountBeforeReconnectClientExit } | Out-Null
    $results.saveAfterReconnectExit = $true
    Invoke-TelemetryStage "reconnect_farmhand_offline" { Wait-FormalHostReady -RequireExpectedFarmhandOffline } | Out-Null

    Copy-Item -LiteralPath $manifestPath -Destination $oldManifestPath -Force
    Stop-SmapI $hostProcess
    $hostProcess = $null
    Clear-GeneratedFile $hostLog
    Clear-GeneratedFile $clientLog

    $restartHostLaunchAtUnixMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $hostProcess = Invoke-TelemetryStage "restart_host_launch" { Start-SmapI $HostModsPath }
    $restartFixtureReadiness = Invoke-TelemetryStage "restart_fixture_readiness" { Wait-FixtureReadiness $hostProcess $restartHostLaunchAtUnixMs }
    if ([string]$restartFixtureReadiness.state -notin @("fixture_ready", "not_required")) { throw "Host restart fixture readiness was not ready." }
    $results.fixtureReadinessAfterHostRestart = $restartFixtureReadiness
    Invoke-TelemetryStage "restart_native_lan_ready" { Wait-HostReady $hostProcess } | Out-Null
    $secondSession = Invoke-TelemetryStage "restart_formal_host_ready" { Wait-FormalHostReady }
    $secondNonce = [string]$secondSession.nonce
    if ([string]::IsNullOrWhiteSpace($firstNonce) -or $firstNonce -eq $secondNonce) { throw "Host restart did not rotate the session nonce." }
    $results.hostRestartNonceRotated = $true

    Copy-Item -LiteralPath $oldManifestPath -Destination $manifestPath -Force
    Clear-GeneratedFile $clientLog
    $clientProcess = Start-SmapI $AiClientModsPath
    # Cold SMAPI + Stardew startup can exceed twenty seconds on the target
    # machine. Reuse the bounded, operator-selected regression timeout so this
    # waits for the actual client-side manifest validation rather than killing
    # the process while it is still before GameLaunched.
    $oldManifestRejected = Invoke-TelemetryStage "restart_old_manifest_rejection" { Wait-LogMarker $clientLog "FarmhandProvisioner failed closed: session_advertisement_mismatch." $TimeoutSeconds }
    if (-not $oldManifestRejected) { throw "Old manifest was not rejected after Host nonce rotation." }
    $results.oldManifestRejectedAfterHostRestart = $true
    Stop-SmapI $clientProcess
    $clientProcess = $null

    Clear-GeneratedFile $manifestPath
    Clear-GeneratedFile $oldManifestPath
    Invoke-TelemetryStage "restart_ai_client_title_ready" { Start-AiClientAndWaitForMod } | Out-Null
    $secondRequest = Invoke-TelemetryStage "restart_attachment_request" { Invoke-AttachmentRequest }
    $results.restartAttachment = $secondRequest
    Invoke-TelemetryStage "restart_ai_client_game_ready" { Wait-ForAiClientReady } | Out-Null
    $results.restartAiClientReady = $true
    Publish-Telemetry "passed"

    [pscustomobject]@{
        state = "passed"
        saveName = $SaveName
        expectedFarmhandId = $ExpectedFarmhandId
        firstNoncePresent = (-not [string]::IsNullOrWhiteSpace($firstNonce))
        secondNoncePresent = (-not [string]::IsNullOrWhiteSpace($secondNonce))
        nonceRotated = $results.hostRestartNonceRotated
        initialAttachment = $results.initialAttachment
        initialAiClientReady = $results.initialAiClientReady
        sameHostReconnectReady = $results.sameHostReconnectReady
        saveAfterInitialClientExit = $results.saveAfterInitialClientExit
        saveAfterReconnectExit = $results.saveAfterReconnectExit
        oldManifestRejectedAfterHostRestart = $results.oldManifestRejectedAfterHostRestart
        fixtureReadiness = $results.fixtureReadiness
        fixtureReadinessAfterHostRestart = $results.fixtureReadinessAfterHostRestart
        restartAttachment = $results.restartAttachment
        restartAiClientReady = $results.restartAiClientReady
        telemetry = [ordered]@{
            path = $telemetryPath
            kind = "stardew_attachment_regression_timing"
            authority = "non_authoritative_diagnostic"
        }
        evidence = "Host SMAPI log + Host-authenticated fixture readiness + AI-client SMAPI-latest.player-2.txt + signed session/response/manifest files + native UDP 24642"
    } | ConvertTo-Json -Depth 8
}
catch {
    try { Publish-Telemetry "failed" } catch { }
    throw
}
finally {
    if (-not $KeepProcesses) {
        if ($null -ne $clientProcess) { Stop-SmapI $clientProcess }
        if ($null -ne $hostProcess) { Stop-SmapI $hostProcess }
    }
    Clear-GeneratedFile $oldManifestPath
}
