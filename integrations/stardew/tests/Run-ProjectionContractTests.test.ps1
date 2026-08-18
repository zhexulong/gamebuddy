[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$runnerPath = Join-Path $PSScriptRoot 'Run-ProjectionContractTests.ps1'
$runner = Get-Content -LiteralPath $runnerPath -Raw

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) { throw $Message }
}

Assert-True ($runner -match '\$portfolioAssemblyPath\s*=\s*Join-Path\s+\$PSScriptRoot\s+"bin\\\$Configuration\\net6\.0\\PortfolioMineElevatorProjection\.Contract\.dll"') `
    'Projection runner must resolve the Portfolio contract entrypoint explicitly.'
Assert-True ($runner -match '\$farmhandAssemblyPath\s*=\s*Join-Path\s+\$PSScriptRoot\s+"bin\\\$Configuration\\net6\.0\\FarmhandActionCapabilityProjection\.Contract\.dll"') `
    'Projection runner must resolve the Farmhand contract entrypoint explicitly.'
Assert-True ($runner -match '(?m)^\s*Invoke-Dotnet\s+\$portfolioAssemblyPath\s+--expected-sha256\s+\$expectedSha256\s+\$productionAssemblyPath\s*$') `
    'Projection runner must invoke only the compiled Portfolio entrypoint directly with its expected digest.'
Assert-True ($runner -match '(?m)^\s*Invoke-Dotnet\s+\$farmhandAssemblyPath\s+--expected-sha256\s+\$expectedSha256\s+\$productionAssemblyPath\s*$') `
    'Projection runner must invoke only the compiled Farmhand entrypoint directly with its expected digest.'
Assert-True ($runner -match '\$sha256\s*=\s*\[System\.Security\.Cryptography\.SHA256\]::Create\(\)') `
    'Projection runner must create the platform-independent SHA-256 implementation.'
Assert-True ($runner -match '\$expectedSha256\s*=\s*-join\s*\(\$sha256\.ComputeHash\(\[System\.IO\.File\]::ReadAllBytes\(\$productionAssemblyPath\)\)\s*\|\s*ForEach-Object\s*\{\s*\$_\.ToString\(''x2''\)\s*\}\s*\)') `
    'Projection runner must derive lowercase SHA-256 hex from the exact production assembly bytes.'
Assert-True ($runner -match '(?s)try\s*\{.*?\$expectedSha256.*?\}\s*finally\s*\{\s*\$sha256\.Dispose\(\)\s*\}') `
    'Projection runner must dispose its SHA-256 implementation after hashing the production assembly.'
Assert-True ($runner -notmatch 'Get-FileHash') `
    'Projection runner must not depend on the optional Get-FileHash cmdlet.'
Assert-True ($runner -notmatch '(?im)^\s*Invoke-Dotnet\s+run(?:\s|$)') `
    'Projection runner must not launch a project with Invoke-Dotnet run, which can select a sibling contract launcher from a shared output directory.'
Assert-True ($runner -notmatch '(?im)^\s*&\s*dotnet\s+run(?:\s|$)') `
    'Projection runner must not directly launch a project with dotnet run, which can select a sibling contract launcher from a shared output directory.'

Write-Output 'Projection contract runner isolation tests passed.'
