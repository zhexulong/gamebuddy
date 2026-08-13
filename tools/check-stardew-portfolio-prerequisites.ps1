[CmdletBinding()]
param()

# This command is deliberately a local-environment gate. Missing profile/game
# inputs are reported by the Node checker as BLOCKED (exit 2), never PASS.
$root = Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")
node (Join-Path $root "tools/check-stardew-portfolio-prerequisites.mjs")
exit $LASTEXITCODE
