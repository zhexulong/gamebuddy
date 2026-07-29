param(
  [string]$EnvFile = (Join-Path $PSScriptRoot "..\.env.local"),
  [switch]$VerifyRedaction
)

if (-not (Test-Path -LiteralPath $EnvFile)) { throw "Local key file not found: $EnvFile" }
foreach ($line in Get-Content -LiteralPath $EnvFile) {
  if ($line -match '^MIMO_API_KEY=(.+)$') { $env:MIMO_API_KEY = $Matches[1].Trim(); break }
}
if ([string]::IsNullOrWhiteSpace($env:MIMO_API_KEY)) { throw "MIMO_API_KEY is absent from the local key file." }
node (Join-Path $PSScriptRoot "capture-mimo-contract.mjs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if ($VerifyRedaction) {
  $fixture = Get-Content -Raw (Join-Path $PSScriptRoot "..\fixtures\voice\mimo-v2.5-tts-sse-redacted.json")
  foreach ($forbidden in @($env:MIMO_API_KEY, "Authorization:", "Bearer ", "base64", '"data"\s*:')) {
    if (-not [string]::IsNullOrEmpty($forbidden) -and $fixture -match [regex]::Escape($forbidden)) {
      throw "Redacted MiMo fixture contains forbidden secret/payload material."
    }
  }
  Write-Host "MiMo contract fixture redaction verification passed."
}
