# Verdict-rule proof for tools/sandbox/sandbox-verify.cmd.
#
# The gate's verdict is the only thing standing between "the install worked" and "the install looked like it
# worked", so a verdict that cannot say FAIL is worse than no verdict: it reports success for a broken
# artifact. This exercises the rule directly against three synthetic transcripts:
#
#   * a green one, which must pass;
#   * a red one (one product check violated), which must fail AND name that check;
#   * an empty one, which must not pass vacuously.
#
# The rule is read out of the shipping script and evaluated in a scratch directory, so this runs anywhere -
# it does not need a sandbox, a share, or a previous run. An earlier version required the gate to be staged
# in `C:\gamebuddy-share`, which made the proof depend on sandbox state and fail outside a run.
#
# Measured defect this caught: the predicate half of the rule compared text carrying a trailing space, so
# `EndsWith('SMAPI LGPL text present')` failed, the check fell to the observed-value branch, and the failing
# value `1` was accepted. The red transcript passed. Both halves are trimmed before comparison.

$ErrorActionPreference = 'Stop'

$gateSource = Join-Path $PSScriptRoot 'sandbox-verify.cmd'
if (-not (Test-Path -LiteralPath $gateSource)) { throw "shipping_gate_absent:$gateSource" }

# The verdict line is lifted out of the shipping script: this proof must run the real rule, not a copy.
$line = Get-Content -LiteralPath $gateSource |
    Where-Object { $_ -match 'gamebuddy-sandbox-result' } |
    Select-Object -First 1
if (-not $line) { throw "verdict_line_absent_in:$gateSource" }

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("gamebuddy-verdict-proof-" + [guid]::NewGuid().ToString('n').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
$resultFile = Join-Path $scratch 'sandbox-result.txt'
$summaryFile = Join-Path $scratch 'sandbox-result.json'

function Invoke-Verdict([string]$Transcript) {
    Set-Content -LiteralPath $resultFile -Value $Transcript -Encoding utf8
    if (Test-Path -LiteralPath $summaryFile) { Remove-Item -LiteralPath $summaryFile -Force }
    $command = $line.Replace('%RESULT%', $resultFile).Replace('%SUMMARY%', $summaryFile)
    $command = $command -replace '^powershell -NoProfile -Command "', '' -replace '" 2>&1$', ''
    Invoke-Expression $command
    $raw = (Get-Content -Raw -LiteralPath $summaryFile) -replace '^\uFEFF', ''
    return $raw | ConvertFrom-Json
}

$green = @(
    '[setup] Setup.exe present in share | ok',
    '[setup] install reported installer_ok | installer_ok',
    '[layout] program root created | ok',
    '[generation] pointer names a generation | g-test',
    '[shortcut] desktop shortcut target | C:\Users\x\Desktop\a.lnk',
    '[compliance] SMAPI LGPL text present | 0',
    '[uninstall] program root removed | ok'
) -join "`r`n"

$red = $green -replace '\[compliance\] SMAPI LGPL text present \| 0', '[compliance] SMAPI LGPL text present | 1'

$failures = 0
function Report([string]$label, [bool]$ok, [string]$detail) {
    if ($ok) { Write-Host ("ok   " + $label + $(if ($detail) { " -> " + $detail } else { '' })) }
    else { Write-Host ("FAIL " + $label + $(if ($detail) { " -> " + $detail } else { '' })); $script:failures++ }
}

$greenResult = Invoke-Verdict $green
Report 'green transcript passes' ($greenResult.ok -eq $true) ("ok=$($greenResult.ok) checks=$($greenResult.productChecks)")
Report 'green transcript counts every check' ($greenResult.productChecks -eq 7) "count=$($greenResult.productChecks)"

$redResult = Invoke-Verdict $red
Report 'red transcript fails' ($redResult.ok -eq $false) ("ok=$($redResult.ok)")
Report 'red transcript names exactly one failure' ($redResult.failingCount -eq 1) "count=$($redResult.failingCount)"
Report 'red transcript names the violated check' (($redResult.failing -join ' ') -match 'SMAPI LGPL text present') (($redResult.failing -join ' '))

$emptyResult = Invoke-Verdict ''
Report 'empty transcript does not pass vacuously' ($emptyResult.ok -eq $false) ("ok=$($emptyResult.ok)")

# A stale line from a previous run must not be counted: the recorder clears the transcript before the gate
# starts, and this asserts the rule itself still works on a transcript that contains exactly one run.
$twoRuns = $green + "`r`n" + "[uninstall] removal completion marker written | FAIL:missing"
$twoRunResult = Invoke-Verdict $twoRuns
Report 'a transcript containing a stale failure still fails' ($twoRunResult.ok -eq $false) ("failing=$($twoRunResult.failingCount)")

Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ''
if ($failures -eq 0) { Write-Host 'verdict_rule_proven' }
exit $failures
