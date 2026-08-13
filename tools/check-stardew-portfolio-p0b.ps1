[CmdletBinding()]
param()

$root = Resolve-Path (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "..")
node (Join-Path $root "tools/check-stardew-portfolio-p0b.mjs")
exit $LASTEXITCODE
