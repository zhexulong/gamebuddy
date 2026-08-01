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
    [int]$TimeoutSeconds = 120
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$smapi = Join-Path $GamePath "StardewModdingAPI.exe"
$hostLog = Join-Path $env:APPDATA "StardewValley\ErrorLogs\SMAPI-latest.txt"
$clientLog = Join-Path $env:APPDATA "StardewValley\ErrorLogs\SMAPI-latest.player-2.txt"
$manifestPath = Join-Path $SessionDirectory "stardew-farmhand-manifest.json"
$oldManifestPath = Join-Path $SessionDirectory "stardew-farmhand-manifest.regression-old.json"

foreach ($path in @($smapi, $HostModsPath, $AiClientModsPath, $HostConfigPath)) {
    if (-not (Test-Path -LiteralPath $path)) { throw "Missing regression path: $path" }
}
if (-not [System.IO.Path]::IsPathFullyQualified($SessionDirectory)) { throw "SessionDirectory must be absolute." }
New-Item -ItemType Directory -Force -Path $SessionDirectory | Out-Null

$hostProcess = $null
$clientProcess = $null
$results = [ordered]@{}

function Clear-GeneratedFile([string]$Path) {
    Remove-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
}

function Clear-SessionExchange {
    foreach ($name in @(
        "stardew-session.json",
        "stardew-attachment-request.json",
        "stardew-attachment-response.json",
        "stardew-farmhand-manifest.json",
        "stardew-farmhand-manifest.regression-old.json"
    )) {
        Clear-GeneratedFile (Join-Path $SessionDirectory $name)
    }
}

function Start-SmapI([string]$ModsPath) {
    Start-Process -FilePath $smapi -ArgumentList @("--mods-path", $ModsPath) -WorkingDirectory $GamePath -PassThru
}

function Stop-SmapI([System.Diagnostics.Process]$Process) {
    if ($null -eq $Process) { return }
    $current = Get-Process -Id $Process.Id -ErrorAction SilentlyContinue
    if ($null -eq $current) { return }
    $current.CloseMainWindow() | Out-Null
    $deadline = [DateTime]::UtcNow.AddSeconds(8)
    do {
        Start-Sleep -Milliseconds 250
        $current = Get-Process -Id $Process.Id -ErrorAction SilentlyContinue
    } while ($null -ne $current -and [DateTime]::UtcNow -lt $deadline)
    if ($null -ne $current) { $current.Kill() }
}

function Wait-HostReady([System.Diagnostics.Process]$Process) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $marker = "HostAutomation native world ready for save '$SaveName'; native LAN server started."
    do {
        Start-Sleep -Milliseconds 500
        if ($Process.HasExited) { throw "Host SMAPI exited before native readiness." }
        $loaded = (Test-Path -LiteralPath $hostLog -PathType Leaf) -and ((Get-Content -Raw -LiteralPath $hostLog -ErrorAction SilentlyContinue) -match [regex]::Escape($marker))
        $server = $false
        try { $server = $null -ne (Get-NetUDPEndpoint -LocalPort 24642 -ErrorAction Stop | Select-Object -First 1) } catch { $server = $false }
    } until (($loaded -and $server) -or [DateTime]::UtcNow -ge $deadline)
    if (-not ($loaded -and $server)) { throw "Host did not become native-LAN ready." }
}

function Wait-LogMarker([string]$Path, [string]$Marker, [int]$Seconds = $TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        Start-Sleep -Milliseconds 250
        $content = if (Test-Path -LiteralPath $Path) { Get-Content -Raw -LiteralPath $Path -ErrorAction SilentlyContinue } else { "" }
        if ($content.Contains($Marker)) { return $true }
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}

function Wait-FormalHostReady {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    $path = Join-Path $SessionDirectory "stardew-session.json"
    do {
        Start-Sleep -Milliseconds 250
        if (Test-Path -LiteralPath $path) {
            try {
                $advertisement = Get-Content -Raw -LiteralPath $path | ConvertFrom-Json
                if ([string]$advertisement.state -eq "ready") { return $advertisement }
            } catch { }
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    $state = if (Test-Path -LiteralPath $path) { [string](Get-Content -Raw -LiteralPath $path | ConvertFrom-Json).state } else { "missing" }
    throw "Formal Host advertisement did not become ready; final_state=$state"
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

function Start-AndVerifyAiClient {
    Clear-GeneratedFile $clientLog
    $script:clientProcess = Start-SmapI $AiClientModsPath
    $ready = Wait-LogMarker $clientLog "FarmhandProvisioner reached readyToPlay with the expected native Farmhand identity and save/world scope."
    if (-not $ready) {
        $failure = if (Test-Path -LiteralPath $clientLog) { Get-Content -Raw -LiteralPath $clientLog } else { "client_log_missing" }
        throw "Formal AI-client did not reach readyToPlay: $failure"
    }
    return $true
}

try {
    Clear-SessionExchange
    Clear-GeneratedFile $hostLog
    Clear-GeneratedFile $clientLog

    $hostProcess = Start-SmapI $HostModsPath
    Wait-HostReady $hostProcess
    $firstSession = Wait-FormalHostReady
    $firstNonce = [string]$firstSession.nonce
    $firstRequest = Invoke-AttachmentRequest
    $results.initialAttachment = $firstRequest

    $saveCountBeforeFirstClient = Get-HostSaveCompletedCount
    Start-AndVerifyAiClient | Out-Null
    $results.initialAiClientReady = $true
    Stop-SmapI $clientProcess
    $clientProcess = $null
    Wait-HostSaveCompleted $saveCountBeforeFirstClient
    $results.saveAfterInitialClientExit = $true
    Wait-FormalHostReady | Out-Null

    $saveCountBeforeReconnect = Get-HostSaveCompletedCount
    Start-AndVerifyAiClient | Out-Null
    $results.sameHostReconnectReady = $true
    Stop-SmapI $clientProcess
    $clientProcess = $null
    Wait-HostSaveCompleted $saveCountBeforeReconnect
    $results.saveAfterReconnectExit = $true
    Wait-FormalHostReady | Out-Null

    Copy-Item -LiteralPath $manifestPath -Destination $oldManifestPath -Force
    Stop-SmapI $hostProcess
    $hostProcess = $null
    Clear-GeneratedFile $hostLog
    Clear-GeneratedFile $clientLog

    $hostProcess = Start-SmapI $HostModsPath
    Wait-HostReady $hostProcess
    $secondSession = Wait-FormalHostReady
    $secondNonce = [string]$secondSession.nonce
    if ([string]::IsNullOrWhiteSpace($firstNonce) -or $firstNonce -eq $secondNonce) { throw "Host restart did not rotate the session nonce." }
    $results.hostRestartNonceRotated = $true

    Copy-Item -LiteralPath $oldManifestPath -Destination $manifestPath -Force
    Clear-GeneratedFile $clientLog
    $clientProcess = Start-SmapI $AiClientModsPath
    $oldManifestRejected = Wait-LogMarker $clientLog "FarmhandProvisioner failed closed: session_advertisement_mismatch." 20
    if (-not $oldManifestRejected) { throw "Old manifest was not rejected after Host nonce rotation." }
    $results.oldManifestRejectedAfterHostRestart = $true
    Stop-SmapI $clientProcess
    $clientProcess = $null

    Clear-GeneratedFile $manifestPath
    Clear-GeneratedFile $oldManifestPath
    $secondRequest = Invoke-AttachmentRequest
    $results.restartAttachment = $secondRequest
    Start-AndVerifyAiClient | Out-Null
    $results.restartAiClientReady = $true

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
        restartAttachment = $results.restartAttachment
        restartAiClientReady = $results.restartAiClientReady
        evidence = "Host SMAPI log + AI-client SMAPI-latest.player-2.txt + signed session/response/manifest files + native UDP 24642"
    } | ConvertTo-Json -Depth 8
}
finally {
    if ($null -ne $clientProcess) { Stop-SmapI $clientProcess }
    if ($null -ne $hostProcess) { Stop-SmapI $hostProcess }
    Clear-GeneratedFile $oldManifestPath
}
