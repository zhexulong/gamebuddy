[CmdletBinding(DefaultParameterSetName = "Restore")]
param(
    [Parameter(Mandatory = $true)]
    [string]$FixtureRoot,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^GameBuddyFixture[A-Za-z0-9_-]{0,96}$')]
    [string]$TemplateName,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^GameBuddyFixture[A-Za-z0-9_-]{0,96}$')]
    [string]$SaveName,

    [string]$StardewSaveRoot = (Join-Path $env:APPDATA 'StardewValley\Saves'),

    [switch]$Cleanup,

    # Explicitly opt-in, read-only source cloning for a new fixture template.
    # The source is never modified; a target-version Host must subsequently load
    # and save the copy before it becomes a validated native fixture template.
    [Parameter(ParameterSetName = "InitializeTemplate", Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9_-]{1,128}$')]
    [string]$InitializeFromSaveName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-AbsolutePath([string]$Path, [string]$Name) {
    if ([string]::IsNullOrWhiteSpace($Path) -or -not (Split-Path -Path $Path -IsAbsolute)) {
        throw "$Name must be an absolute path."
    }
}

function Assert-ChildPath([string]$Parent, [string]$Child, [string]$Name) {
    $parentFull = [IO.Path]::GetFullPath($Parent).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $childFull = [IO.Path]::GetFullPath($Child)
    if (-not $childFull.StartsWith($parentFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw "$Name escapes its allowed root."
    }
}

function Assert-DisjointRoots([string]$First, [string]$Second) {
    $firstFull = [IO.Path]::GetFullPath($First).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    $secondFull = [IO.Path]::GetFullPath($Second).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
    if ($firstFull.StartsWith($secondFull, [StringComparison]::OrdinalIgnoreCase) -or $secondFull.StartsWith($firstFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'FixtureRoot and StardewSaveRoot must be disjoint; templates may not live inside the active save root.'
    }
}

function Assert-NoGameProcesses {
    $running = @(Get-Process -Name 'StardewModdingAPI','Stardew Valley','StardewValley' -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) {
        $ids = ($running | ForEach-Object Id) -join ','
        throw "Refusing fixture file operation while Stardew/SMAPI is running (PIDs: $ids)."
    }
}

function Copy-NativeFixtureTemplate([string]$Source, [string]$Destination) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $Source -Force) {
        Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $Destination $entry.Name) -Recurse -Force
    }
}

function Copy-ReadOnlySaveAsFixtureTemplate([string]$Source, [string]$Destination, [string]$SourceName, [string]$FixtureName) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $Source -Force) {
        $destinationName = if ($entry.Name.StartsWith($SourceName, [StringComparison]::Ordinal)) {
            $FixtureName + $entry.Name.Substring($SourceName.Length)
        } else {
            $entry.Name
        }
        Copy-Item -LiteralPath $entry.FullName -Destination (Join-Path $Destination $destinationName) -Recurse -Force
    }
}

Assert-AbsolutePath $FixtureRoot 'FixtureRoot'
Assert-AbsolutePath $StardewSaveRoot 'StardewSaveRoot'
$fixtureRootFull = [IO.Path]::GetFullPath($FixtureRoot)
$saveRootFull = [IO.Path]::GetFullPath($StardewSaveRoot)
Assert-DisjointRoots $fixtureRootFull $saveRootFull
$templatePath = Join-Path $fixtureRootFull (Join-Path 'templates' $TemplateName)
$workingSavePath = Join-Path $saveRootFull $SaveName
Assert-ChildPath $fixtureRootFull $templatePath 'Template path'
Assert-ChildPath $saveRootFull $workingSavePath 'Working save path'
if ($PSCmdlet.ParameterSetName -eq 'InitializeTemplate') {
    $sourceSavePath = Join-Path $saveRootFull $InitializeFromSaveName
    Assert-ChildPath $saveRootFull $sourceSavePath 'Source save path'
}

if (-not $SaveName.StartsWith('GameBuddyFixture', [StringComparison]::Ordinal) -or -not $TemplateName.StartsWith('GameBuddyFixture', [StringComparison]::Ordinal)) {
    throw 'Only explicitly prefixed GameBuddyFixture saves may be handled.'
}
if ($SaveName -ne $TemplateName) {
    throw 'SaveName must exactly equal TemplateName: Stardew native save files embed their directory name.'
}

Assert-NoGameProcesses

if ($PSCmdlet.ParameterSetName -eq 'InitializeTemplate') {
    # Source and template may use the same native slot basename because their
    # roots are disjoint: source is the real save root and template is an
    # external read-only fixture root. This lets us capture a target-version
    # native-created save without renaming its embedded identity.
    if (-not (Test-Path -LiteralPath $sourceSavePath -PathType Container)) {
        throw "Source save directory is missing: $sourceSavePath"
    }
    $sourceSave = Join-Path $sourceSavePath $InitializeFromSaveName
    $sourceInfo = Join-Path $sourceSavePath 'SaveGameInfo'
    if (-not (Test-Path -LiteralPath $sourceSave -PathType Leaf) -or -not (Test-Path -LiteralPath $sourceInfo -PathType Leaf)) {
        throw 'Source save must contain its native named save file and SaveGameInfo.'
    }
    if (Test-Path -LiteralPath $templatePath) {
        throw "Refusing to overwrite an existing fixture template: $templatePath"
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $templatePath) -Force | Out-Null
    Copy-ReadOnlySaveAsFixtureTemplate $sourceSavePath $templatePath $InitializeFromSaveName $TemplateName
    $templateSave = Join-Path $templatePath $TemplateName
    $templateInfo = Join-Path $templatePath 'SaveGameInfo'
    if (-not (Test-Path -LiteralPath $templateSave -PathType Leaf) -or -not (Test-Path -LiteralPath $templateInfo -PathType Leaf)) {
        Remove-Item -LiteralPath $templatePath -Recurse -Force -ErrorAction SilentlyContinue
        throw 'Fixture template initialization did not produce a complete native save directory.'
    }
    [pscustomobject]@{
        state = 'template_initialized'
        sourceSaveName = $InitializeFromSaveName
        templateName = $TemplateName
        templatePath = $templatePath
        contract = 'Read-only copy and primary filename rename only; source XML, inventory, action state, and receipt were not edited. Load and native-save this template before using it as success-gate evidence.'
    } | ConvertTo-Json
    exit 0
}

if ($Cleanup) {
    if (Test-Path -LiteralPath $workingSavePath) {
        Remove-Item -LiteralPath $workingSavePath -Recurse -Force
    }
    [pscustomobject]@{
        state = 'cleaned'
        saveName = $SaveName
        workingSavePath = $workingSavePath
    } | ConvertTo-Json
    exit 0
}

if (-not (Test-Path -LiteralPath $templatePath -PathType Container)) {
    throw "Fixture template directory is missing: $templatePath"
}

$templateSave = Join-Path $templatePath $TemplateName
$templateInfo = Join-Path $templatePath 'SaveGameInfo'
if (-not (Test-Path -LiteralPath $templateSave -PathType Leaf) -or -not (Test-Path -LiteralPath $templateInfo -PathType Leaf)) {
    throw 'Fixture template must contain its native named save file and SaveGameInfo.'
}

if (Test-Path -LiteralPath $workingSavePath) {
    Remove-Item -LiteralPath $workingSavePath -Recurse -Force
}
New-Item -ItemType Directory -Path $saveRootFull -Force | Out-Null
Copy-NativeFixtureTemplate $templatePath $workingSavePath

$workingSave = Join-Path $workingSavePath $SaveName
$workingInfo = Join-Path $workingSavePath 'SaveGameInfo'
if (-not (Test-Path -LiteralPath $workingSave -PathType Leaf) -or -not (Test-Path -LiteralPath $workingInfo -PathType Leaf)) {
    Remove-Item -LiteralPath $workingSavePath -Recurse -Force -ErrorAction SilentlyContinue
    throw 'Fixture restore did not produce a complete native save directory.'
}

[pscustomobject]@{
    state = 'restored'
    saveName = $SaveName
    templatePath = $templatePath
    workingSavePath = $workingSavePath
    nativeFiles = @($SaveName, 'SaveGameInfo')
    contract = 'Copied native template only; no save XML, action state, receipt, or inventory field was edited.'
} | ConvertTo-Json
