param(
  [Parameter(Mandatory = $true)][string]$GamePath,
  [Parameter(Mandatory = $true)][string]$ModsPath,
  [Parameter(Mandatory = $true)][string]$ObservedSaveSlot,
  [Parameter(Mandatory = $true)][string]$ResultPath,
  [Parameter(Mandatory = $true)][Int64]$DeadlineUnixMs
)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class GameBuddyCommandLine {
  [DllImport("shell32.dll", SetLastError = true)]
  public static extern IntPtr CommandLineToArgvW(string commandLine, out int argc);
  [DllImport("kernel32.dll")]
  public static extern IntPtr LocalFree(IntPtr memory);
}
'@
function Test-ExactSmapiCommandLine([string]$CommandLine, [string]$ExpectedSmapi, [string]$ExpectedProfile) {
  $escapedProfile = [regex]::Escape([IO.Path]::GetFullPath($ExpectedProfile))
  # Get-CimInstance preserves the Windows process command line. Match the
  # process executable and exactly one quoted --mods-path without reserializing
  # it through PowerShell's argument binder.
  return $CommandLine -match ('^"' + [regex]::Escape($ExpectedSmapi) + '"\s+--mods-path\s+"' + $escapedProfile + '"\s*$')
}
$gameRoot = [IO.Path]::GetFullPath($GamePath)
$smapi = Join-Path $gameRoot 'StardewModdingAPI.exe'
$profile = [IO.Path]::GetFullPath($ModsPath)
$result = [IO.Path]::GetFullPath($ResultPath)
$transactionRoot = [IO.Path]::GetDirectoryName($result)
$saveRoot = Join-Path $env:APPDATA 'StardewValley\Saves'
$workingSave = Join-Path $saveRoot $ObservedSaveSlot
if (!(Test-Path -LiteralPath $smapi -PathType Leaf) -or !(Test-Path -LiteralPath $profile -PathType Container) -or [string]::IsNullOrWhiteSpace($env:APPDATA) -or !$result.StartsWith($transactionRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($result) -cne 'terminal.json' -or (Test-Path -LiteralPath $result) -or $DeadlineUnixMs -le [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()) { throw 'p4_runtime_launcher_input_invalid' }
if ($ObservedSaveSlot -notmatch '^GameBuddyFixture[A-Za-z0-9]{0,64}_[0-9]{1,32}$' -or !(Test-Path -LiteralPath $workingSave -PathType Container) -or !(Test-Path -LiteralPath (Join-Path $workingSave $ObservedSaveSlot) -PathType Leaf) -or !(Test-Path -LiteralPath (Join-Path $workingSave 'SaveGameInfo') -PathType Leaf)) { throw 'p4_runtime_transaction_save_not_exact' }
$process = $null
try {
  # Windows resolves ApplicationData from the current-user shell profile, not
  # process APPDATA overrides. The runner therefore creates this one exact
  # manifest-owned physical slot under the real Saves root and removes it after
  # the one-shot process exits. The loader can request only this slot.
  $process = Start-Process -FilePath $smapi -ArgumentList @('--mods-path', ('"{0}"' -f $profile)) -WorkingDirectory $gameRoot -PassThru
  $actual = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.Id)"
  if ($null -eq $actual) { throw 'p4_runtime_launched_process_missing' }
  $actualPath = [IO.Path]::GetFullPath($actual.ExecutablePath)
  if ($actualPath -ne $smapi -or -not (Test-ExactSmapiCommandLine $actual.CommandLine $smapi $profile)) { $observed = if ($null -eq $actual.CommandLine) { '<null>' } else { $actual.CommandLine }; $actualPathEscaped = $actualPath.Replace('\\', '/'); $expectedPathEscaped = $smapi.Replace('\\', '/'); Stop-Process -Id $process.Id -Force; throw "p4_runtime_launched_process_identity_or_mods_path_invalid:actual=$actualPathEscaped;expected=$expectedPathEscaped;command=$observed" }
  while (!$process.HasExited -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $DeadlineUnixMs) {
    if (Test-Path -LiteralPath $result -PathType Leaf) { Stop-Process -Id $process.Id -Force; $process.WaitForExit(); break }
    Start-Sleep -Milliseconds 100
    $process.Refresh()
  }
  if (!$process.HasExited) { Stop-Process -Id $process.Id -Force; throw 'p4_runtime_deadline_expired' }
  if (!(Test-Path -LiteralPath $result -PathType Leaf)) { throw 'p4_runtime_terminal_not_written' }
} finally {
  if ($null -ne $process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force; $process.WaitForExit() }
}
