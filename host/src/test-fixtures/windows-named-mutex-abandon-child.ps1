[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Name
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$mutex = [System.Threading.Mutex]::new($false, $Name)
try {
  if (-not $mutex.WaitOne(5000)) { throw 'mutex_acquisition_timeout' }
  [Console]::Out.WriteLine('acquired')
  [Console]::Out.Flush()
  while ($true) { Start-Sleep -Seconds 1 }
} finally {
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
}
