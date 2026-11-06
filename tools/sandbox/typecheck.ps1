param(
    [string]$Project = "host/tsconfig.json",
    [string]$NodeDirectory = "D:\Program Files\nodejs"
)

$ErrorActionPreference = 'Stop'

# The harness PATH lost its Node entry (only anaconda\condabin remained), so `npx` and `tsc` are not
# resolvable here even though the toolchain is installed. Rather than depend on the shell's ambient state,
# this invokes the TypeScript compiler's JavaScript entry point directly through the absolute Node
# executable - no shim, no PATH lookup, nothing that can silently resolve to the wrong binary.
$node = Join-Path $NodeDirectory 'node.exe'
if (-not (Test-Path -LiteralPath $node)) {
    throw "node_absent:$node"
}

$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# TypeScript is hoisted into the `host` workspace, not the repository root: `host/node_modules/typescript`
# is where the compiler lives, and pointing at the root only finds an empty directory.
$compiler = Join-Path $root 'host\node_modules\typescript\bin\tsc'
if (-not (Test-Path -LiteralPath $compiler)) {
    throw "typescript_absent:$compiler"
}

Push-Location $root
try {
    & $node $compiler -p $Project --noEmit
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}
"tsc exit: $code"
exit $code
