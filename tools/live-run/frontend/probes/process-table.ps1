# Probe: the process table, read-only. One JSON object per line on stdout.
#
# Modes (exactly one is meaningful):
#   -ProcessId <n>            the row for that pid (nothing when it is gone)
#   -CommandLineLike <text>   every row whose command line CONTAINS <text>, compared ordinally - a path
#                             containing `[` is a path, not a wildcard pattern
#   -ListenerPort <n>         the pid LISTENING on that TCP port, as `{ listenerPort, pid }`
#
# This exists because the kit must name a process it did not start - the holder of a contended CDP
# port, and the survivors of a failed phase - and the only authority for that is the OS. Reading it
# through a file here (rather than an inline `-Command` string) is the kit's rule for shell logic.
param(
  [int]$ProcessId = 0,
  [string]$CommandLineLike = '',
  [int]$ListenerPort = 0
)
$ErrorActionPreference = 'Continue'

function Emit($record) { Write-Output ($record | ConvertTo-Json -Compress) }

if ($ListenerPort -gt 0) {
  $connection = Get-NetTCPConnection -LocalPort $ListenerPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($connection) { Emit ([pscustomobject]@{ listenerPort = $ListenerPort; pid = [int]$connection.OwningProcess }) }
  exit 0
}

$rows = if ($ProcessId -gt 0) {
  Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $ProcessId) -ErrorAction SilentlyContinue
} else {
  Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue
}
foreach ($row in @($rows)) {
  if ($null -eq $row) { continue }
  $commandLine = [string]$row.CommandLine
  if ($CommandLineLike -ne '' -and $commandLine.IndexOf($CommandLineLike, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
  Emit ([pscustomobject]@{ pid = [int]$row.ProcessId; name = [string]$row.Name; commandLine = $commandLine })
}
exit 0
