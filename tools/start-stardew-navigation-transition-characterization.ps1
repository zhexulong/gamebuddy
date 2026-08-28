param(
  [Parameter(Mandatory = $true)][string]$GamePath,
  [Parameter(Mandatory = $true)][string]$ModsPath,
  [Parameter(Mandatory = $true)][string]$ObservedSaveSlot,
  [Parameter(Mandatory = $true)][string]$ObservationPath,
  [Parameter(Mandatory = $true)][Int64]$DeadlineUnixMs
)
$ErrorActionPreference = 'Stop'
$gameRoot = [IO.Path]::GetFullPath($GamePath)
$smapi = Join-Path $gameRoot 'StardewModdingAPI.exe'
$profile = [IO.Path]::GetFullPath($ModsPath)
$observation = [IO.Path]::GetFullPath($ObservationPath)
$tx = [IO.Path]::GetDirectoryName($observation)
$saveRoot = Join-Path $env:APPDATA 'StardewValley\Saves'
$workingSave = Join-Path $saveRoot $ObservedSaveSlot
if (!(Test-Path -LiteralPath $smapi -PathType Leaf) -or !(Test-Path -LiteralPath $profile -PathType Container) -or [string]::IsNullOrWhiteSpace($env:APPDATA) -or !$observation.StartsWith($tx + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($observation) -cne 'observation.json' -or (Test-Path -LiteralPath $observation) -or $DeadlineUnixMs -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) { throw 'transition_launcher_input_invalid' }
if ($ObservedSaveSlot -notmatch '^GameBuddyFixture[A-Za-z0-9]{0,64}_[0-9]{1,32}$' -or !(Test-Path -LiteralPath $workingSave -PathType Container) -or !(Test-Path -LiteralPath (Join-Path $workingSave $ObservedSaveSlot) -PathType Leaf) -or !(Test-Path -LiteralPath (Join-Path $workingSave 'SaveGameInfo') -PathType Leaf)) { throw 'transition_transaction_save_not_exact' }
function Test-ExactSmapiCommandLine([string]$CommandLine, [string]$ExpectedSmapi, [string]$ExpectedProfile) {
  $escapedProfile = [regex]::Escape([IO.Path]::GetFullPath($ExpectedProfile))
  return $CommandLine -match ('^"' + [regex]::Escape($ExpectedSmapi) + '"\s+--mods-path\s+"' + $escapedProfile + '"\s*$')
}
$process = $null
try {
  $process = Start-Process -FilePath $smapi -ArgumentList @('--mods-path', ('"{0}"' -f $profile)) -WorkingDirectory $gameRoot -PassThru
  $actual = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
  if ($null -eq $actual) { throw 'transition_launched_process_missing' }
  $actualPath = [IO.Path]::GetFullPath($actual.ExecutablePath)
  if ($actualPath -ne $smapi -or -not (Test-ExactSmapiCommandLine $actual.CommandLine $smapi $profile)) {
    if ($null -ne $actual.CommandLine) { $observedCommand = $actual.CommandLine } else { $observedCommand = '<null>' }
    Stop-Process -Id $process.Id -Force
    throw "transition_launched_process_identity_or_mods_path_invalid:command=$observedCommand"
  }
  while (!$process.HasExited -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $DeadlineUnixMs) {
    if (Test-Path -LiteralPath $observation -PathType Leaf) { Stop-Process -Id $process.Id -Force; $process.WaitForExit(); break }
    Start-Sleep -Milliseconds 100
    $process.Refresh()
  }
  if (!$process.HasExited) { Stop-Process -Id $process.Id -Force; throw 'transition_runtime_deadline_expired' }
  if (!(Test-Path -LiteralPath $observation -PathType Leaf)) { throw 'transition_terminal_not_written' }
} finally {
  if ($null -ne $process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force; $process.WaitForExit() }
}
