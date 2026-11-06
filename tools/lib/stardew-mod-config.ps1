Set-StrictMode -Version Latest

function Get-GameBuddyStardewModConfigPath([Parameter(Mandatory = $true)][string]$ModsPath) {
    # The directory name under Mods/ has one owner: tools/lib/stardew-mod-folder.mjs, asserted by
    # tools/check-stardew-mod-folder-name.mjs. These harnesses spelled it by hand and drifted to the MSBuild default,
    # so a lane that deploys Mods/GameBuddy failed preflight with "Missing harness path" naming a directory no fixture
    # writes. Ask the owner instead of spelling it a fifth time.
    $resolver = Join-Path $PSScriptRoot "stardew-bridge-pipe.mjs"
    $resolved = node $resolver --print-config-path $ModsPath
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($resolved)) {
        throw "stardew_mod_config_path_unresolved:$ModsPath"
    }
    return $resolved.Trim()
}
