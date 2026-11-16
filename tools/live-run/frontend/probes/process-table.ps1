# Probe: the process table, read-only. One JSON object per line on stdout, and - for a whole-table
# query - a last `{ examined: N }` line: how many processes the query looked at, so a reading can print
# its population instead of an unqualified zero.
#
# Modes (exactly one is meaningful):
#   -ProcessId <n>            the row for that pid (nothing when it is gone)
#   -CommandLineLike <text>   every row whose command line CONTAINS <text>, compared ordinally - a path
#                             containing `[` is a path, not a wildcard pattern
#   -ListenerPort <n>         the pid LISTENING on that TCP port, as `{ listenerPort, pid }`
#   -NameLike <regex>         every row whose IMAGE NAME matches (the game a run started is named by its
#                             image, never by the run directory in its arguments: the loader carries
#                             `--mods-path <run>`, the game under it carries nothing but its own path)
#   -Table                    every process, WITHOUT its command line: `{ pid, parentPid, name, startTime }`.
#                             The run's ledger needs the whole pid set and the parent relation twice per
#                             run (before, and after teardown) and needs neither command line for it.
#
# `parentPid` and `startTime` travel on every row: they are what tells a pid that the ledger recorded
# from a pid the OS handed to an unrelated process after the fact (`startTime` is the OS's creation
# time), and what resolves a role's own tree (the guardian's descendants) without a name list.
#
# This exists because the kit must name a process it did not start - the holder of a contended CDP
# port, the survivors of a failed phase - and the only authority for that is the OS. Reading it
# through a file here (rather than an inline `-Command` string) is the kit's rule for shell logic.
param(
  [int]$ProcessId = 0,
  [string]$CommandLineLike = '',
  [string]$NameLike = '',
  [int]$ListenerPort = 0,
  [switch]$Table
)
$ErrorActionPreference = 'Continue'

function Emit($record) { Write-Output ($record | ConvertTo-Json -Compress) }

if ($ListenerPort -gt 0) {
  $connection = Get-NetTCPConnection -LocalPort $ListenerPort -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($connection) { Emit ([pscustomobject]@{ listenerPort = $ListenerPort; pid = [int]$connection.OwningProcess }) }
  exit 0
}

# `CreationDate` arrives as a CIM datetime (a `DateTime` under Get-CimInstance); it is rendered into
# one ISO-8601 spelling here so a reader never has to know which shape it got.
function StartTime($row) {
  if ($null -eq $row.CreationDate) { return $null }
  try { return ([datetime]$row.CreationDate).ToString('o') } catch { return ([string]$row.CreationDate) }
}

$examined = 0
$rows = if ($ProcessId -gt 0) {
  Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $ProcessId) -ErrorAction SilentlyContinue
} else {
  Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue
}
foreach ($row in @($rows)) {
  if ($null -eq $row) { continue }
  $examined += 1
  $commandLine = [string]$row.CommandLine
  if ($CommandLineLike -ne '' -and $commandLine.IndexOf($CommandLineLike, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
  if ($NameLike -ne '' -and ([string]$row.Name) -notmatch $NameLike) { continue }
  if ($Table) {
    Emit ([pscustomobject]@{
      pid = [int]$row.ProcessId
      parentPid = [int]$row.ParentProcessId
      name = [string]$row.Name
      startTime = (StartTime $row)
    })
    continue
  }
  Emit ([pscustomobject]@{
    pid = [int]$row.ProcessId
    parentPid = [int]$row.ParentProcessId
    name = [string]$row.Name
    startTime = (StartTime $row)
    commandLine = $commandLine
  })
}
if ($ProcessId -le 0) { Emit ([pscustomobject]@{ examined = $examined }) }
exit 0
