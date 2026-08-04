# Static deterministic contract check for the non-authoritative attachment
# timing artifact. This does not start Stardew, inspect a real session, or
# claim any production/attachment success.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$scriptPath = Join-Path $PSScriptRoot "run-stardew-attachment-regression.ps1"
$text = Get-Content -Raw -LiteralPath $scriptPath
foreach ($required in @(
    'kind = "stardew_attachment_regression_timing"',
    'authority = "non_authoritative_diagnostic"',
    'function Invoke-TelemetryStage',
    'function Publish-Telemetry',
    'Publish-Telemetry "passed"',
    'Publish-Telemetry "failed"',
    'stardew-attachment-telemetry.json',
    '[Text.UTF8Encoding]::new($false)'
)) {
    if (-not $text.Contains($required)) { throw "attachment_telemetry_contract_missing:$required" }
}
if ($text -match 'evidence\s*=.*telemetry') { throw "attachment_telemetry_must_not_be_evidence" }
Write-Output "stardew_attachment_telemetry_contract_passed"
