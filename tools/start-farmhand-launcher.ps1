[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$GamePath,

    [Parameter(Mandatory = $true)]
    [string]$ExpectedFarmhandId,

    [Parameter(Mandatory = $true)]
    [string]$ModsPath,

    [ValidateRange(10, 300)]
    [int]$StartupTimeoutSeconds = 90,

    [switch]$StartHost,

    [switch]$StartAiClient
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$smapi = Join-Path $GamePath "StardewModdingAPI.exe"
if (-not (Test-Path -LiteralPath $smapi -PathType Leaf)) {
    throw "Missing official SMAPI launcher: $smapi"
}
if (-not [System.IO.Path]::IsPathFullyQualified($ModsPath)) {
    $ModsPath = Join-Path $GamePath $ModsPath
}
if (-not (Test-Path -LiteralPath $ModsPath -PathType Container)) {
    throw "Mods path does not exist: $ModsPath"
}
if ($ExpectedFarmhandId -notmatch "^[0-9]{6,20}$") {
    throw "ExpectedFarmhandId must be a native Stardew multiplayer ID."
}
if (-not $StartHost -and -not $StartAiClient) {
    throw "Specify -StartHost, -StartAiClient, or both."
}

function Start-OfficialSmapi([string]$Role) {
    $process = Start-Process -FilePath $smapi -ArgumentList @("--mods-path", $ModsPath) -WorkingDirectory $GamePath -PassThru
    [pscustomobject]@{ role = $Role; pid = $process.Id; modsPath = $ModsPath; startedAtUtc = [DateTime]::UtcNow.ToString("O") }
}

$started = @()
if ($StartHost) { $started += Start-OfficialSmapi "host" }
if ($StartAiClient) { $started += Start-OfficialSmapi "ai_client" }

$deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
foreach ($entry in $started) {
    do {
        Start-Sleep -Milliseconds 500
        $process = Get-Process -Id $entry.pid -ErrorAction SilentlyContinue
        if ($null -eq $process) {
            throw "Official SMAPI $($entry.role) process exited before its title window became available."
        }
    } until ($process.MainWindowHandle -ne [IntPtr]::Zero -or [DateTime]::UtcNow -ge $deadline)

    if ($process.MainWindowHandle -eq [IntPtr]::Zero) {
        throw "Timed out waiting for official SMAPI $($entry.role) window."
    }
}

[pscustomobject]@{
    expectedFarmhandId = $ExpectedFarmhandId
    modsPath = $ModsPath
    started = $started
    next = "Use the official Join LAN/Farmhand selection UI only in the ai_client window. After GameBuddy logs the configured Farmhand binding, stop UI automation and use the local named-pipe bridge."
} | ConvertTo-Json -Depth 4
