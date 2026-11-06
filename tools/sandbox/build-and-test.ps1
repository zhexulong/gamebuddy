param(
    [string]$NodeDirectory = "D:\Program Files\nodejs",
    [string]$Project = "host/tsconfig.test.json",
    [string[]]$TestFile = @()
)

$ErrorActionPreference = 'Stop'

# The harness PATH is unusable in this shell (it holds thousands of entries from other lanes, and `node`
# is not resolvable), so every verification step goes through absolute paths.
#
# It always emits: the test runner executes the compiled output, so a `--noEmit` check would leave the
# previous build in place and silently run the older test - which is how a new test appears to pass before
# it has ever been compiled.
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$node = Join-Path $NodeDirectory 'node.exe'
$compiler = Join-Path $root 'host\node_modules\typescript\bin\tsc'
foreach ($required in @($node, $compiler)) {
    if (-not (Test-Path -LiteralPath $required)) { throw "absent:$required" }
}

Push-Location $root
try {
    & $node $compiler -p $Project
    $compileCode = $LASTEXITCODE
    "compile exit: $compileCode"
    if ($compileCode -ne 0) { exit $compileCode }

    if ($TestFile.Count -gt 0) {
        & $node --test @TestFile
        exit $LASTEXITCODE
    }
} finally {
    Pop-Location
}
exit 0
