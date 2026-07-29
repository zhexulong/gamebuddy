[CmdletBinding()]
param(
    [string]$GamePath = $env:GAMEBUDDY_STARDEW_GAME_PATH,
    [ValidateSet("Debug", "Release")]
    [string]$Configuration = "Release",
    [int]$WaitSeconds = 20
)

if ([string]::IsNullOrWhiteSpace($GamePath)) {
    throw "Set GAMEBUDDY_STARDEW_GAME_PATH or pass -GamePath to a Stardew Valley + SMAPI installation."
}

$projectRoot = Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")
& (Join-Path $PSScriptRoot "deploy-stardew.ps1") -GamePath $GamePath -Configuration $Configuration
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$smapi = Join-Path $GamePath "StardewModdingAPI.exe"
if (-not (Test-Path -LiteralPath $smapi -PathType Leaf)) { throw "SMAPI executable not found: $smapi" }
$logPath = Join-Path $env:APPDATA "StardewValley\ErrorLogs\SMAPI-latest.txt"
$before = if (Test-Path -LiteralPath $logPath) { (Get-Item -LiteralPath $logPath).LastWriteTimeUtc } else { [DateTime]::MinValue }
$runStarted = [DateTime]::UtcNow

$process = Start-Process -FilePath $smapi -WorkingDirectory $GamePath -PassThru
try {
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    do {
        Start-Sleep -Milliseconds 500
        if (Test-Path -LiteralPath $logPath) {
            # SMAPI replaces/truncates this file during startup. Read and stat
            # independently, then tolerate a transient empty/null read.
            $item = Get-Item -LiteralPath $logPath -ErrorAction SilentlyContinue
            $content = Get-Content -Raw -LiteralPath $logPath -ErrorAction SilentlyContinue
            if ($null -ne $item -and $null -ne $content -and $item.LastWriteTimeUtc -ge $runStarted.AddSeconds(-5) -and $content.Contains("GameBuddy embodiment loaded")) {
                Write-Host "GameBuddy single-client SMAPI load smoke passed."
                exit 0
            }
        }
    } while ([DateTime]::UtcNow -lt $deadline -and -not $process.HasExited)

    throw "GameBuddy load marker was not observed in SMAPI-latest.txt within $WaitSeconds seconds."
}
finally {
    if (-not $process.HasExited) {
        $process.CloseMainWindow() | Out-Null
        Start-Sleep -Seconds 2
        if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force }
    }
}
