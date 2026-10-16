# Probe: syntax-check a list of shell scripts with the PowerShell parser (no execution).
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ps-parse.ps1 <file> [<file>...]
$failed = 0
foreach ($file in $args) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $file), [ref]$tokens, [ref]$errors)
  if ($errors -and $errors.Count -gt 0) {
    Write-Output ("ERR " + $file + " parseErrors=" + $errors.Count)
    $errors | Select-Object -First 5 | ForEach-Object { Write-Output ("  " + $_.Message) }
    $failed = $failed + 1
  } else {
    Write-Output ("OK " + $file)
  }
}
if ($failed -gt 0) { exit 1 }
exit 0