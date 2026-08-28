param(
  [Parameter(Mandatory = $true)][string]$GamePath,
  [Parameter(Mandatory = $true)][string]$ProfilePath,
  [Parameter(Mandatory = $true)][string]$ObservedSaveSlot,
  [Parameter(Mandatory = $true)][string]$ObservationPath,
  [Parameter(Mandatory = $true)][Int64]$DeadlineUnixMs
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class GameBuddyNavigationCharacterizationCommandLine {
  [DllImport("shell32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern IntPtr CommandLineToArgvW(string commandLine, out int argc);
  [DllImport("kernel32.dll")]
  public static extern IntPtr LocalFree(IntPtr memory);
}
'@
function Test-RegularNonLink([string]$Path, [bool]$Directory) {
  if (!(Test-Path -LiteralPath $Path -PathType $(if ($Directory) { 'Container' } else { 'Leaf' }))) { return $false }
  $item = Get-Item -LiteralPath $Path -Force
  return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0)
}
function Test-FullyQualifiedWindowsPath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  return $Path -match '^(?:[A-Za-z]:\\|\\\\[^\\/:*?"<>|]+\\[^\\/:*?"<>|]+\\)'
}
function Test-ExactSmapiCommandLine([string]$CommandLine, [string]$ExpectedSmapi, [string]$ExpectedProfile) {
  if ([string]::IsNullOrEmpty($CommandLine)) { return $false }
  $expectedArgs = @('--mods-path', $ExpectedProfile)
  $argv = 0
  $memory = [GameBuddyNavigationCharacterizationCommandLine]::CommandLineToArgvW($CommandLine, [ref]$argv)
  if ($memory -eq [IntPtr]::Zero -or $argv -ne 3) {
    if ($memory -ne [IntPtr]::Zero) { [void][GameBuddyNavigationCharacterizationCommandLine]::LocalFree($memory) }
    return $false
  }
  try {
    $actual = for ($index = 0; $index -lt $argv; $index++) {
      [Runtime.InteropServices.Marshal]::PtrToStringUni([Runtime.InteropServices.Marshal]::ReadIntPtr($memory, $index * [IntPtr]::Size))
    }
    return $actual[0] -ceq $ExpectedSmapi -and $actual[1] -ceq $expectedArgs[0] -and $actual[2] -ceq $expectedArgs[1]
  } finally {
    [void][GameBuddyNavigationCharacterizationCommandLine]::LocalFree($memory)
  }
}
function Get-VerifiedLaunchedSmapiProcess {
  param(
    [Int32]$ProcessId,
    [Int64]$ExpectedCreationUnixMs,
    [string]$ExactSmapi,
    [string]$ExactProfile
  )
  $actual = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId"
  if ($null -eq $actual) { return $null }
  if ([string]::IsNullOrEmpty($actual.ExecutablePath) -or [string]::IsNullOrEmpty($actual.CreationDate) -or
      ([DateTimeOffset]$actual.CreationDate).ToUnixTimeMilliseconds() -ne $ExpectedCreationUnixMs -or
      [IO.Path]::GetFullPath($actual.ExecutablePath) -cne $ExactSmapi -or
      !(Test-ExactSmapiCommandLine $actual.CommandLine $ExactSmapi $ExactProfile)) {
    throw 'multisource_launcher_process_identity_or_command_line_invalid'
  }
  return $actual
}
function Stop-VerifiedLaunchedSmapiProcess {
  param(
    [Diagnostics.Process]$Process,
    [Int64]$ExpectedCreationUnixMs,
    [string]$ExactSmapi,
    [string]$ExactProfile
  )
  $actual = Get-VerifiedLaunchedSmapiProcess -ProcessId $Process.Id -ExpectedCreationUnixMs $ExpectedCreationUnixMs -ExactSmapi $ExactSmapi -ExactProfile $ExactProfile
  if ($null -eq $actual) {
    $Process.Refresh()
    if ($Process.HasExited) { return }
    throw 'multisource_launcher_launched_process_missing'
  }
  Stop-Process -Id $Process.Id -Force
  $Process.WaitForExit()
}
function Start-NavigationMultiSourceCharacterizationSmapi {
  param(
    [string]$ExactSmapi,
    [string]$ExactGameRoot,
    [string]$ExactProfile,
    [string]$ExactObservedSaveSlot,
    [string]$ExactObservationPath,
    [Int64]$ExactDeadlineUnixMs
  )
  $process = $null
  [Int64]$processCreationUnixMs = 0
  try {
    $startedProcess = Start-Process -FilePath $ExactSmapi -ArgumentList @('--mods-path', ('"{0}"' -f $ExactProfile)) -WorkingDirectory $ExactGameRoot -PassThru
    # A successfully returned handle is cleanup-owned before any fallible identity
    # inspection. Otherwise a rejected inspection can orphan SMAPI while the caller
    # removes the profile it is still about to scan.
    $process = $startedProcess
    $actual = Get-CimInstance Win32_Process -Filter "ProcessId=$($startedProcess.Id)"
    if ($null -eq $actual -or [string]::IsNullOrEmpty($actual.CreationDate)) { throw 'multisource_launcher_launched_process_missing' }
    $processCreationUnixMs = ([DateTimeOffset]$actual.CreationDate).ToUnixTimeMilliseconds()
    Get-VerifiedLaunchedSmapiProcess -ProcessId $startedProcess.Id -ExpectedCreationUnixMs $processCreationUnixMs -ExactSmapi $ExactSmapi -ExactProfile $ExactProfile | Out-Null
    $observationObserved = $false
    while ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $ExactDeadlineUnixMs) {
      $process.Refresh()
      if ($process.HasExited) { throw 'multisource_launcher_process_exited_before_observation' }
      if (Test-RegularNonLink $ExactObservationPath $false) {
        $observationObserved = $true
        break
      }
      Start-Sleep -Milliseconds 100
    }
    if (!$observationObserved) { throw 'multisource_launcher_deadline_or_early_observation' }
    Stop-VerifiedLaunchedSmapiProcess -Process $process -ExpectedCreationUnixMs $processCreationUnixMs -ExactSmapi $ExactSmapi -ExactProfile $ExactProfile
    if (!(Test-RegularNonLink $ExactObservationPath $false)) { throw 'multisource_launcher_observation_not_regular' }
  } finally {
    if ($null -ne $process) {
      $process.Refresh()
      if (!$process.HasExited) { Stop-VerifiedLaunchedSmapiProcess -Process $process -ExpectedCreationUnixMs $processCreationUnixMs -ExactSmapi $ExactSmapi -ExactProfile $ExactProfile }
    }
  }
}

$gameRoot = [IO.Path]::GetFullPath($GamePath)
$smapi = Join-Path $gameRoot 'StardewModdingAPI.exe'
$profile = [IO.Path]::GetFullPath($ProfilePath)
$observation = [IO.Path]::GetFullPath($ObservationPath)
$transactionRoot = [IO.Path]::GetDirectoryName($observation)
$saveRoot = Join-Path $env:APPDATA 'StardewValley\Saves'
$workingSave = Join-Path $saveRoot $ObservedSaveSlot
if ([string]::IsNullOrWhiteSpace($env:APPDATA) -or
    !(Test-FullyQualifiedWindowsPath $GamePath) -or !(Test-FullyQualifiedWindowsPath $ProfilePath) -or !(Test-FullyQualifiedWindowsPath $ObservationPath) -or
    $GamePath -cne $gameRoot -or $ProfilePath -cne $profile -or $ObservationPath -cne $observation -or
    $smapi -cne (Join-Path $gameRoot 'StardewModdingAPI.exe') -or
    !(Test-RegularNonLink $smapi $false) -or !(Test-RegularNonLink $profile $true) -or
    [IO.Path]::GetFileName($observation) -cne 'observation.json' -or $observation -cne (Join-Path $transactionRoot 'observation.json') -or
    (Test-Path -LiteralPath $observation) -or
    $DeadlineUnixMs -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) { throw 'multisource_launcher_input_invalid' }
if ($ObservedSaveSlot -notmatch '^GameBuddyFixture[A-Za-z0-9]{0,64}_[0-9]{1,32}$' -or
    !(Test-RegularNonLink $workingSave $true) -or
    !(Test-RegularNonLink (Join-Path $workingSave $ObservedSaveSlot) $false) -or
    !(Test-RegularNonLink (Join-Path $workingSave 'SaveGameInfo') $false)) { throw 'multisource_launcher_transaction_save_not_exact' }
Start-NavigationMultiSourceCharacterizationSmapi -ExactSmapi $smapi -ExactGameRoot $gameRoot -ExactProfile $profile -ExactObservedSaveSlot $ObservedSaveSlot -ExactObservationPath $observation -ExactDeadlineUnixMs $DeadlineUnixMs
