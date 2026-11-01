# Probe: print the SHA-256 of a file using .NET directly (never the Get-FileHash cmdlet, which is
# unavailable in some constrained PowerShell hosts the kit is invoked from). One hex digest per line.
param([Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Path)
foreach ($p in $Path) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [System.IO.File]::ReadAllBytes($p)
    $digest = [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')
    Write-Output $digest
  } finally {
    $sha.Dispose()
  }
}