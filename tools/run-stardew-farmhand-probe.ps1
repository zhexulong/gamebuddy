[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$GamePath,

    [Parameter(Mandatory = $true)]
    [string]$HostModsPath,

    [Parameter(Mandatory = $true)]
    [string]$ProbeModsPath,

    [Parameter(Mandatory = $true)]
    [string]$SaveName,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9]{6,20}$')]
    [string]$ExpectedFarmhandId,

    [Parameter(Mandatory = $true)]
    [string]$SessionDirectory,

    [ValidateRange(30, 300)]
    [int]$HostTimeoutSeconds = 120,

    [ValidateRange(10, 120)]
    [int]$ProbeTimeoutSeconds = 60,

    [switch]$KeepHostRunning
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$smapi = Join-Path $GamePath "StardewModdingAPI.exe"
if (-not (Test-Path -LiteralPath $smapi -PathType Leaf)) { throw "Missing SMAPI launcher: $smapi" }
foreach ($path in @($HostModsPath, $ProbeModsPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw "Missing Mods profile: $path" }
}
if (-not [System.IO.Path]::IsPathFullyQualified($SessionDirectory)) { throw "SessionDirectory must be absolute." }
New-Item -ItemType Directory -Force -Path $SessionDirectory | Out-Null
foreach ($name in @("stardew-session.json", "stardew-attachment-request.json", "stardew-attachment-response.json", "stardew-farmhand-manifest.json")) {
    Remove-Item -LiteralPath (Join-Path $SessionDirectory $name) -Force -ErrorAction SilentlyContinue
}

$logPath = Join-Path $env:APPDATA "StardewValley\ErrorLogs\SMAPI-latest.txt"
$probeLogPath = Join-Path $env:APPDATA "StardewValley\ErrorLogs\SMAPI-latest.player-2.txt"
$hostStartedAt = [DateTime]::UtcNow
$hostProcess = Start-Process -FilePath $smapi -ArgumentList @("--mods-path", $HostModsPath) -WorkingDirectory $GamePath -PassThru
$probe = $null
try {
    $hostDeadline = [DateTime]::UtcNow.AddSeconds($HostTimeoutSeconds)
    $hostReady = $false
    do {
        Start-Sleep -Milliseconds 500
        if ($hostProcess.HasExited) { throw "Host SMAPI exited before native save/server readiness." }
        $content = if (Test-Path -LiteralPath $logPath) { Get-Content -Raw -LiteralPath $logPath -ErrorAction SilentlyContinue } else { "" }
        $loadedSave = $content -match [regex]::Escape("HostAutomation native world ready for save '$SaveName'; native LAN server started.")
        $serverReady = $false
        try {
            $hostTreeIds = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($hostProcess.Id)" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId)
            $hostTreeIds += $hostProcess.Id
            $udp = Get-NetUDPEndpoint -LocalPort 24642 -ErrorAction Stop | Where-Object { $hostTreeIds -contains $_.OwningProcess }
            $serverReady = $null -ne $udp
        } catch { $serverReady = $false }
        $advertisementPath = Join-Path $SessionDirectory "stardew-session.json"
        $advertisement = $false
        $advertisementState = "missing"
        if (Test-Path -LiteralPath $advertisementPath) {
            try {
                $advertisementDocument = Get-Content -Raw -LiteralPath $advertisementPath | ConvertFrom-Json
                $advertisementState = [string]$advertisementDocument.state
                $advertisement = $advertisementState -eq "ready"
            } catch {
                $advertisementState = "invalid"
            }
        }
        # This script validates the diagnostic probe, whose contract predates
        # formal App/Host advertisement. Host readiness is native save load plus
        # the real LAN server; formal advertisement readiness is reported separately.
        $hostReady = $loadedSave -and $serverReady
    } until ($hostReady -or [DateTime]::UtcNow -ge $hostDeadline)
    if (-not $hostReady) { throw "Host did not produce loaded-save and native UDP 24642 in time." }

    $advertisementDeadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 100
        $advertisementPath = Join-Path $SessionDirectory "stardew-session.json"
        if (Test-Path -LiteralPath $advertisementPath) {
            try {
                $advertisementDocument = Get-Content -Raw -LiteralPath $advertisementPath | ConvertFrom-Json
                $advertisementState = [string]$advertisementDocument.state
                $advertisement = $advertisementState -eq "ready"
            } catch {
                $advertisementState = "invalid"
            }
        }
    } until ($advertisement -or [DateTime]::UtcNow -ge $advertisementDeadline)

    $probeStartedAt = [DateTime]::UtcNow
    $probe = Start-Process -FilePath $smapi -ArgumentList @("--mods-path", $ProbeModsPath) -WorkingDirectory $GamePath -PassThru
    $probeDeadline = [DateTime]::UtcNow.AddSeconds($ProbeTimeoutSeconds)
    $probeReady = $false
    do {
        Start-Sleep -Milliseconds 500
        if ($probe.HasExited) { break }
        $content = if (Test-Path -LiteralPath $probeLogPath) { Get-Content -Raw -LiteralPath $probeLogPath -ErrorAction SilentlyContinue } else { "" }
        $recent = $content
        $probeReady = ($recent.Contains("GameBuddy provisioning probe finished: ready_to_play=True") -and
            $recent.Contains("expected_farmhand_id=$ExpectedFarmhandId") -and
            $recent.Contains("identity_match=True"))
    } until ($probeReady -or [DateTime]::UtcNow -ge $probeDeadline)

    $advertisementPath = Join-Path $SessionDirectory "stardew-session.json"
    if (Test-Path -LiteralPath $advertisementPath) {
        try {
            $advertisementDocument = Get-Content -Raw -LiteralPath $advertisementPath | ConvertFrom-Json
            $advertisementState = [string]$advertisementDocument.state
            $advertisement = $advertisementState -eq "ready"
        } catch {
            $advertisementState = "invalid"
            $advertisement = $false
        }
    }

    [pscustomobject]@{
        hostPid = $hostProcess.Id
        probePid = if ($probe) { $probe.Id } else { $null }
        hostStartedAtUtc = $hostStartedAt.ToString("O")
        probeStartedAtUtc = if ($probe) { $probeStartedAt.ToString("O") } else { $null }
        hostReady = $hostReady
        probeReady = $probeReady
        expectedFarmhandId = $ExpectedFarmhandId
        formalHostAdvertisementReady = $advertisement
        formalHostAdvertisementState = $advertisementState
        evidence = "SMAPI-latest.txt + SMAPI-latest.player-2.txt + native UDP 24642"
    } | ConvertTo-Json -Depth 4
    if (-not $probeReady) { exit 2 }
}
finally {
    if ($null -ne $probe -and -not $probe.HasExited) {
        $probe.CloseMainWindow() | Out-Null
        Start-Sleep -Seconds 2
        if (-not $probe.HasExited) { $probe.Kill() }
    }
    if (-not $KeepHostRunning -and -not $hostProcess.HasExited) {
        $hostProcess.CloseMainWindow() | Out-Null
        Start-Sleep -Seconds 3
        if (-not $hostProcess.HasExited) { $hostProcess.Kill() }
    }
}
